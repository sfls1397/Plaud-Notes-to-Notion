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

export interface DeletionResult {
  trashed: Array<{ pageId: string; side: "summary" | "transcript"; minute: string }>;
  restored: Array<{ pageId: string; side: "summary" | "transcript"; minute: string }>;
  tracked: number;
}

/** How long a trashed pair stays eligible for restore (Notion keeps trash ~30 days). */
const RESTORE_WINDOW_MS = 30 * 86_400_000;

/**
 * A Summary and its Transcript live and die together: trash either one and the
 * other is trashed; restore either one from the trash and the other comes back.
 *
 * Notion queries never return trashed pages, so every cycle this remembers the
 * live Summary↔Transcript pairs (same Recorded minute, exactly one of each) and
 * checks any remembered page that stopped appearing. It only acts when Notion
 * explicitly reports that page as in the trash — a 404 (permanent delete, or
 * lost access) is never treated as a deletion.
 */
export async function runDeletionSync(deps: SyncDeps): Promise<DeletionResult> {
  const now = (deps.now || (() => new Date()))();
  const pairs = (deps.state.pairs ||= {});
  const result: DeletionResult = { trashed: [], restored: [], tracked: 0 };
  const since = new Date(now.getTime() - SYNC_FULL_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await deps.notion.rowsRecordedSince(since);
  const live = new Set(rows.map((r) => r.id));
  const verb = (v: string) => (deps.dryRun ? `DRY RUN would ${v}` : v);

  const setTrashed = async (pageId: string, side: "summary" | "transcript", minute: string, inTrash: boolean, why: string) => {
    if (!deps.dryRun) {
      await deps.notion.setTrashed(pageId, inTrash);
    }
    (inTrash ? result.trashed : result.restored).push({ pageId, side, minute });
    deps.log(`[${deps.profile}] ${verb(inTrash ? "trash" : "restore")} ${side === "summary" ? "Summary" : "Transcript"} ${minute} (${why})`);
  };

  for (const [summaryId, pair] of Object.entries(pairs)) {
    const summaryLive = live.has(summaryId);
    const transcriptLive = live.has(pair.transcriptId);

    if (pair.trashedAt) {
      if (summaryLive || transcriptLive) {
        // One side came back from the trash: bring the other back too.
        if (!summaryLive) {
          await setTrashed(summaryId, "summary", pair.minute, false, "its Transcript was restored");
        }
        if (!transcriptLive) {
          await setTrashed(pair.transcriptId, "transcript", pair.minute, false, "its Summary was restored");
        }
        if (!deps.dryRun) {
          delete pair.trashedAt;
          delete pair.trashed;
        }
      } else if (now.getTime() - Date.parse(pair.trashedAt) > RESTORE_WINDOW_MS) {
        delete pairs[summaryId];
      }
      continue;
    }

    if (summaryLive && transcriptLive) {
      continue;
    }
    const summaryState = summaryLive ? "live" : await deps.notion.pageState(summaryId);
    const transcriptState = transcriptLive ? "live" : await deps.notion.pageState(pair.transcriptId);

    if (summaryState === "trashed" && transcriptState === "live") {
      await setTrashed(pair.transcriptId, "transcript", pair.minute, true, "its Summary was deleted");
      if (!deps.dryRun) {
        pair.trashedAt = now.toISOString();
        pair.trashed = "transcript";
      }
    } else if (transcriptState === "trashed" && summaryState === "live") {
      await setTrashed(summaryId, "summary", pair.minute, true, "its Transcript was deleted");
      if (!deps.dryRun) {
        pair.trashedAt = now.toISOString();
        pair.trashed = "summary";
      }
    } else if (summaryState === "trashed" && transcriptState === "trashed") {
      if (!deps.dryRun) {
        pair.trashedAt = now.toISOString(); // both deleted by hand — still restore together
        pair.trashed = "both";
      }
    } else {
      if (summaryState === "unknown" || transcriptState === "unknown") {
        deps.log(`[${deps.profile}] a page for ${pair.minute} is no longer visible (not in trash); leaving its partner alone`);
      }
      delete pairs[summaryId]; // aged out of the window, moved (Recorded edited), or not visible — re-paired below if live
    }
  }

  const groups = new Map<string, NotionRow[]>();
  for (const row of rows) {
    const key = minuteKey(row.recorded);
    if (key) {
      groups.set(key, [...(groups.get(key) || []), row]);
    }
  }
  for (const [minute, group] of groups) {
    const summaries = group.filter((r) => r.types.includes(TYPE_SUMMARY));
    const transcripts = group.filter((r) => r.types.includes(TYPE_TRANSCRIPT) && !r.types.includes(TYPE_SUMMARY));
    if (summaries.length === 1 && transcripts.length === 1 && !pairs[summaries[0].id]?.trashedAt) {
      pairs[summaries[0].id] = { transcriptId: transcripts[0].id, minute };
    }
  }
  result.tracked = Object.values(pairs).filter((p) => !p.trashedAt).length;
  if (!deps.dryRun) {
    deps.save();
  }
  return result;
}
