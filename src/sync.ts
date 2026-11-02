import { SYNC_FULL_EVERY_HOURS, SYNC_FULL_WINDOW_DAYS, TYPE_SUMMARY, TYPE_TRANSCRIPT } from "./constants.js";
import type { NotionRow, NotionStore } from "./notion.js";
import type { ProfileState } from "./state.js";

/**
 * Keeps each Transcript row's Meeting title and Participants equal to its
 * Summary sibling. Only Summary edits flow to Transcripts — never the other way.
 *
 * Siblings are found by page id (Toolbox rules/notion.md → Find Notion items by
 * id): state.pairs maps each Summary page id to its Transcript page id, filled
 * when this service writes a recording and backfilled from the file state.
 * Only a Summary with no pair yet is matched by Recorded minute (exactly one
 * Summary and one Transcript in that minute, as the retired Grok routine did);
 * the match is then remembered by id. Ambiguous minutes are skipped.
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

export function minuteKey(recorded: string | null | undefined): string | null {
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

type Plan = { transcript: NotionRow; patch: { title?: string; participants?: string[] }; changes: string[] };

const isSummary = (r: NotionRow) => r.types.includes(TYPE_SUMMARY);
const isTranscript = (r: NotionRow) => r.types.includes(TYPE_TRANSCRIPT) && !r.types.includes(TYPE_SUMMARY);

/** The one Summary and one Transcript in a Recorded minute (first-time fallback only). */
export function pairInGroup(rows: NotionRow[]): { summary: NotionRow; transcript: NotionRow } | "ambiguous" | null {
  const summaries = rows.filter(isSummary);
  const transcripts = rows.filter(isTranscript);
  if (summaries.length === 0 || transcripts.length === 0) {
    return null;
  }
  if (summaries.length > 1 || transcripts.length > 1) {
    return "ambiguous";
  }
  return { summary: summaries[0], transcript: transcripts[0] };
}

/**
 * Remembers a Summary↔Transcript pair by page id. Refuses (false) when either
 * page is already paired with a different page.
 */
export function rememberPair(state: ProfileState, summaryId: string, transcriptId: string, minute: string): boolean {
  const pairs = (state.pairs ||= {});
  if (pairs[summaryId]) {
    return pairs[summaryId].transcriptId === transcriptId;
  }
  if (Object.values(pairs).some((p) => p.transcriptId === transcriptId)) {
    return false;
  }
  pairs[summaryId] = { transcriptId, minute };
  return true;
}

/** Pairs for every recording this service wrote: its file state holds both page ids. */
export function backfillPairsFromFiles(state: ProfileState): number {
  let added = 0;
  for (const f of Object.values(state.files)) {
    const minute = minuteKey(f.recorded);
    if (f.summaryPageId && f.transcriptPageId && minute && !state.pairs?.[f.summaryPageId]) {
      if (rememberPair(state, f.summaryPageId, f.transcriptPageId, minute)) {
        added++;
      }
    }
  }
  return added;
}

export function planGroup(rows: NotionRow[]): Plan | "ambiguous" | null {
  const pair = pairInGroup(rows);
  return pair === null || pair === "ambiguous" ? pair : planPair(pair.summary, pair.transcript);
}

export function planPair(s: NotionRow, t: NotionRow): Plan | null {
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

  backfillPairsFromFiles(deps.state);
  const pairs = (deps.state.pairs ||= {});
  const inHand = new Map<string, NotionRow>();
  const byMinute = new Map<string, NotionRow[]>();
  let summaries: NotionRow[];
  if (full) {
    const since = new Date(now.getTime() - SYNC_FULL_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = await deps.notion.rowsRecordedSince(since);
    for (const row of rows) {
      inHand.set(row.id, row);
      const key = minuteKey(row.recorded);
      if (key) {
        byMinute.set(key, [...(byMinute.get(key) || []), row]);
      }
    }
    summaries = rows.filter(isSummary);
  } else {
    const since = new Date(Date.parse(deps.state.lastSyncAt as string) - OVERLAP_MS).toISOString();
    summaries = await deps.notion.summariesEditedSince(since);
  }

  const done = new Set<string>();
  for (const summary of summaries) {
    if (done.has(summary.id)) {
      continue;
    }
    done.add(summary.id);
    const key = minuteKey(summary.recorded) || "(no Recorded)";
    const pair = pairs[summary.id];
    let transcript: NotionRow | null = null;
    if (pair) {
      if (pair.trashedAt || pair.gone) {
        continue;
      }
      result.groupsChecked++;
      // By id. A Transcript in the trash or gone is the deletion sync's business, never a re-match.
      transcript = inHand.get(pair.transcriptId) ?? (await deps.notion.rowById(pair.transcriptId));
      if (!transcript) {
        continue;
      }
    } else {
      const minute = minuteKey(summary.recorded);
      if (!minute) {
        continue;
      }
      result.groupsChecked++;
      const found = pairInGroup(full ? byMinute.get(minute) || [] : await deps.notion.rowsAtMinute(minute));
      if (found === "ambiguous") {
        result.ambiguous++;
        continue;
      }
      if (!found || found.summary.id !== summary.id) {
        continue;
      }
      if (!rememberPair(deps.state, summary.id, found.transcript.id, minute)) {
        result.ambiguous++; // that Transcript already belongs to another Summary
        continue;
      }
      transcript = found.transcript;
    }
    const plan = planPair(summary, transcript);
    if (plan === null) {
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
 * Notion queries never return trashed pages, so every cycle this checks, by
 * page id, any remembered pair (state.pairs) whose page stopped appearing in
 * the last SYNC_FULL_WINDOW_DAYS. Pairs are kept by id; a live Summary with no
 * pair yet is paired by Recorded minute (exactly one of each) the first time.
 * It only acts when Notion explicitly reports a page as in the trash — a 404
 * (permanent delete, or lost access) is never treated as a deletion.
 */
export async function runDeletionSync(deps: SyncDeps): Promise<DeletionResult> {
  const now = (deps.now || (() => new Date()))();
  backfillPairsFromFiles(deps.state);
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
    if (pair.gone || pair.minute < since) {
      continue; // older than the window: kept for the title sync, no longer watched for deletion
    }
    const summaryLive = live.has(summaryId);
    const transcriptLive = live.has(pair.transcriptId);

    if (pair.trashedAt) {
      // Past RESTORE_WINDOW_MS Notion has emptied its trash; the pair is kept so it is never re-made.
      if ((summaryLive || transcriptLive) && now.getTime() - Date.parse(pair.trashedAt) <= RESTORE_WINDOW_MS) {
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
    } else if (summaryState === "unknown" || transcriptState === "unknown") {
      deps.log(`[${deps.profile}] a page for ${pair.minute} is no longer visible (not in trash); leaving its partner alone`);
      if (!deps.dryRun) {
        pair.gone = now.toISOString();
      }
    }
    // Both live but outside the window (Recorded edited): the pair stays.
  }

  const groups = new Map<string, NotionRow[]>();
  for (const row of rows) {
    const key = minuteKey(row.recorded);
    if (key) {
      groups.set(key, [...(groups.get(key) || []), row]);
    }
  }
  for (const [minute, group] of groups) {
    // First-time pairing only: rememberPair leaves every page that already has a pair alone.
    const found = pairInGroup(group);
    if (found && found !== "ambiguous") {
      rememberPair(deps.state, found.summary.id, found.transcript.id, minute);
    }
  }
  result.tracked = Object.values(pairs).filter((p) => !p.trashedAt && !p.gone).length;
  if (!deps.dryRun) {
    deps.save();
  }
  return result;
}
