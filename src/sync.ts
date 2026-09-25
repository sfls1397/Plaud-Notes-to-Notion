import { SYNC_FULL_EVERY_HOURS, SYNC_FULL_WINDOW_DAYS, TYPE_SUMMARY, TYPE_TRANSCRIPT } from "./constants.js";
import type { NotionRow, NotionStore } from "./notion.js";
import type { ProfileState } from "./state.js";

/**
 * Keeps each Transcript row's Meeting title and Participants equal to its
 * Summary sibling (paired by Recorded, to the minute). Only Summary edits flow
 * to Transcripts — never the other way. Ambiguous minutes (more than one
 * Summary or Transcript) are skipped, as the retired Grok routine did.
 */
export interface SyncDeps {
  profile: string;
  notion: NotionStore;
  state: ProfileState;
  save: () => void;
  log: (msg: string) => void;
  now?: () => Date;
  dryRun?: boolean;
}

export interface SyncResult {
  mode: "incremental" | "full";
  groupsChecked: number;
  updated: Array<{ id: string; title: string; changes: string[] }>;
  ambiguous: number;
}

const OVERLAP_MS = 2 * 60_000;

function minuteKey(recorded: string | null): string | null {
  if (!recorded) {
    return null;
  }
  const t = Date.parse(recorded);
  if (!Number.isFinite(t)) {
    return null;
  }
  return new Date(Math.floor(t / 60_000) * 60_000).toISOString();
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

export function planGroup(rows: NotionRow[]): { transcript: NotionRow; patch: { title?: string; participants?: string[] }; changes: string[] } | "ambiguous" | null {
  const summaries = rows.filter((r) => r.types.includes(TYPE_SUMMARY));
  const transcripts = rows.filter((r) => r.types.includes(TYPE_TRANSCRIPT) && !r.types.includes(TYPE_SUMMARY));
  if (summaries.length === 0 || transcripts.length === 0) {
    return null;
  }
  if (summaries.length > 1 || transcripts.length > 1) {
    return "ambiguous";
  }
  const [s] = summaries;
  const [t] = transcripts;
  const patch: { title?: string; participants?: string[] } = {};
  const changes: string[] = [];
  if (s.title.trim() && s.title !== t.title) {
    patch.title = s.title;
    changes.push(`title "${t.title}" → "${s.title}"`);
  }
  if (!sameSet(s.participants, t.participants)) {
    patch.participants = s.participants;
    changes.push(`participants ${JSON.stringify(t.participants)} → ${JSON.stringify(s.participants)}`);
  }
  return changes.length ? { transcript: t, patch, changes } : null;
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const now = (deps.now || (() => new Date()))();
  const lastFull = deps.state.lastFullSyncAt ? Date.parse(deps.state.lastFullSyncAt) : 0;
  const full = !deps.state.lastSyncAt || now.getTime() - lastFull > SYNC_FULL_EVERY_HOURS * 3_600_000;
  const result: SyncResult = { mode: full ? "full" : "incremental", groupsChecked: 0, updated: [], ambiguous: 0 };

  const groups = new Map<string, NotionRow[]>();
  if (full) {
    const since = new Date(now.getTime() - SYNC_FULL_WINDOW_DAYS * 86_400_000).toISOString();
    for (const row of await deps.notion.rowsRecordedSince(since)) {
      const key = minuteKey(row.recorded);
      if (key) {
        groups.set(key, [...(groups.get(key) || []), row]);
      }
    }
  } else {
    const since = new Date(Date.parse(deps.state.lastSyncAt as string) - OVERLAP_MS).toISOString();
    for (const summary of await deps.notion.summariesEditedSince(since)) {
      const key = minuteKey(summary.recorded);
      if (key && !groups.has(key)) {
        groups.set(key, await deps.notion.rowsAtMinute(key));
      }
    }
  }

  for (const [key, rows] of groups) {
    result.groupsChecked++;
    const plan = planGroup(rows);
    if (plan === null) {
      continue;
    }
    if (plan === "ambiguous") {
      result.ambiguous++;
      continue;
    }
    if (!deps.dryRun) {
      await deps.notion.updateRow(plan.transcript.id, plan.patch);
    }
    result.updated.push({ id: plan.transcript.id, title: plan.patch.title ?? plan.transcript.title, changes: plan.changes });
    deps.log(`[${deps.profile}] ${deps.dryRun ? "DRY RUN would sync" : "synced"} Transcript ${key}: ${plan.changes.join("; ")}`);
  }

  if (!deps.dryRun) {
    deps.state.lastSyncAt = now.toISOString();
    if (full) {
      deps.state.lastFullSyncAt = now.toISOString();
    }
    deps.save();
  }
  return result;
}
