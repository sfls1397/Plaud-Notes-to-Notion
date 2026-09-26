import { LLM_MAX_ATTEMPTS, PENDING_FAST_HOURS, TYPE_SUMMARY, TYPE_TRANSCRIPT, WATCH_DAYS } from "./constants.js";
import {
  cleanParticipants,
  cleanSummaryMarkdown,
  cleanTitle,
  fallbackTitle,
  formatTranscript,
  recordedMinute
} from "./format.js";
import type { Labeler } from "./llm.js";
import type { NotionRow, NotionStore, RowType } from "./notion.js";
import type { PlaudClient, PlaudFileListing, PlaudRecording } from "./plaud/client.js";
import { redactSsnAcross } from "./ssn.js";
import type { FileState, ProfileState } from "./state.js";
import { safeErrorMessage } from "./redact.js";

export interface IngestDeps {
  profile: string;
  owner: string;
  startAfter: Date;
  plaud: PlaudClient;
  notion: NotionStore;
  labeler: Labeler;
  state: ProfileState;
  save: () => void;
  log: (msg: string) => void;
  now?: () => Date;
  dryRun?: boolean;
}

export interface IngestResult {
  checked: number;
  written: Array<{ id: string; title: string }>;
  pending: number;
  errors: string[];
}

const DEEP_SCAN_PAGES = 15;

/**
 * Files to look at this cycle, oldest upload first:
 *  - new files (uploaded at/after startAfter) not seen yet;
 *  - files still waiting on Plaud (no summary/transcript yet) — every cycle while
 *    fresh, only on deep scans once they are "slow" (older than PENDING_FAST_HOURS).
 * Plaud lists by recording start, so a deep scan (every 10 min) walks back
 * WATCH_DAYS to catch late uploads and summaries generated late on old recordings.
 */
async function candidates(deps: IngestDeps, deep: boolean): Promise<PlaudFileListing[]> {
  const now = (deps.now || (() => new Date()))();
  const floor = new Date(now.getTime() - WATCH_DAYS * 86_400_000);
  const out: PlaudFileListing[] = [];
  const pages = deep ? DEEP_SCAN_PAGES : 1;
  for (let page = 1; page <= pages; page++) {
    const list = await deps.plaud.listFiles(page, 20);
    for (const f of list) {
      const uploaded = f.createdAt || f.startAt;
      const st = deps.state.files[f.id];
      if (st) {
        if (st.status === "pending" && (deep || !st.slow)) {
          out.push(f);
        }
      } else if (uploaded && uploaded >= deps.startAfter) {
        out.push(f);
      }
    }
    const oldest = list.at(-1)?.startAt;
    if (list.length < 20 || !oldest || oldest < floor) {
      break;
    }
  }
  return out.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/**
 * One-time snapshot at cutover: every recording from the last WATCH_DAYS that was
 * uploaded before startAfter. Ones Plaud has already finished belonged to the Zap
 * ("baseline", never written). Ones still without a summary/transcript go on the
 * slow watch list, so a summary generated later is still written — as the Zap did.
 */
export async function runBaseline(deps: IngestDeps): Promise<{ baseline: number; watching: number }> {
  const now = (deps.now || (() => new Date()))();
  const floor = new Date(now.getTime() - WATCH_DAYS * 86_400_000);
  let baseline = 0;
  let watching = 0;
  for (let page = 1; page <= DEEP_SCAN_PAGES; page++) {
    const list = await deps.plaud.listFiles(page, 20);
    for (const f of list) {
      const uploaded = f.createdAt || f.startAt;
      if (deps.state.files[f.id] || !uploaded || uploaded >= deps.startAfter) {
        continue;
      }
      const rec = await deps.plaud.getRecording(f.id);
      const ready = Boolean(rec.summaryMarkdown && rec.segments.length > 0 && rec.startAt);
      deps.state.files[f.id] = ready
        ? { status: "baseline", firstSeen: now.toISOString(), name: rec.name, llmAttempts: 0 }
        : { status: "pending", slow: true, firstSeen: now.toISOString(), name: rec.name, llmAttempts: 0 };
      ready ? baseline++ : watching++;
    }
    const oldest = list.at(-1)?.startAt;
    if (list.length < 20 || !oldest || oldest < floor) {
      break;
    }
  }
  if (!deps.dryRun) {
    deps.state.baselineAt = now.toISOString();
    deps.save();
  }
  deps.log(`[${deps.profile}] baseline: ${baseline} recording(s) already handled before cutover; watching ${watching} still without a summary`);
  return { baseline, watching };
}

/** A row we (or a crashed earlier attempt) already wrote: same minute, same Type, same title. */
function alreadyWritten(rows: NotionRow[], type: RowType, title: string): NotionRow | undefined {
  return rows.find((r) => r.types.includes(type) && r.title.trim() === title.trim());
}

export interface PreparedRecording {
  recorded: string;
  summaryMarkdown: string;
  transcriptText: string;
  plaudTitle: string;
  ssnRedactions: number;
}

/** Everything that happens to Plaud text before it leaves this Mac. */
export function prepareRecording(rec: PlaudRecording): PreparedRecording {
  const redacted = redactSsnAcross({
    summary: rec.summaryMarkdown || "",
    transcript: formatTranscript(rec.segments),
    title: rec.name
  });
  return {
    recorded: recordedMinute(rec.startAt as Date),
    summaryMarkdown: cleanSummaryMarkdown(redacted.texts.summary),
    transcriptText: redacted.texts.transcript,
    plaudTitle: redacted.texts.title,
    ssnRedactions: redacted.count
  };
}

async function processOne(deps: IngestDeps, file: PlaudFileListing, st: FileState, result: IngestResult): Promise<void> {
  const now = (deps.now || (() => new Date()))();
  const rec = await deps.plaud.getRecording(file.id);
  st.name = rec.name;
  if (!rec.summaryMarkdown || rec.segments.length === 0 || !rec.startAt) {
    const waitedH = (now.getTime() - Date.parse(st.firstSeen)) / 3_600_000;
    if (!st.slow && waitedH > PENDING_FAST_HOURS) {
      st.slow = true;
      deps.log(`[${deps.profile}] "${rec.name}" still has no ${!rec.summaryMarkdown ? "summary" : "transcript"} after ${PENDING_FAST_HOURS}h; checking it every 10 min instead`);
    }
    result.pending++;
    return;
  }

  const prepared = prepareRecording(rec);
  st.recorded = prepared.recorded;
  st.ssnRedactions = prepared.ssnRedactions;
  if (prepared.ssnRedactions > 0) {
    deps.log(`[${deps.profile}] redacted ${prepared.ssnRedactions} SSN mention(s) in "${prepared.plaudTitle}"`);
  }

  if (!st.title) {
    const notionSchema = await deps.notion.schema();
    try {
      const labels = await deps.labeler.label({
        owner: deps.owner,
        plaudTitle: prepared.plaudTitle,
        summaryMarkdown: prepared.summaryMarkdown,
        transcriptText: prepared.transcriptText,
        knownParticipants: notionSchema.participantOptions
      });
      st.title = cleanTitle(labels.title) || fallbackTitle(prepared.plaudTitle);
      st.participants = cleanParticipants(labels.participants, deps.owner);
      st.labelSource = "llm";
    } catch (err) {
      st.llmAttempts++;
      st.lastError = safeErrorMessage(err);
      if (st.llmAttempts < LLM_MAX_ATTEMPTS) {
        deps.log(`[${deps.profile}] labeling failed for "${prepared.plaudTitle}" (attempt ${st.llmAttempts}/${LLM_MAX_ATTEMPTS}): ${st.lastError}`);
        result.pending++;
        return;
      }
      st.title = fallbackTitle(prepared.plaudTitle);
      st.participants = [];
      st.labelSource = "fallback";
      deps.log(`[${deps.profile}] labeling failed ${LLM_MAX_ATTEMPTS}x; writing "${st.title}" with Plaud's title and no participants`);
    }
    deps.save();
  }

  const title = st.title as string;
  const participants = st.participants || [];
  if (deps.dryRun) {
    deps.log(
      `[${deps.profile}] DRY RUN would write "${title}" Recorded ${prepared.recorded} Participants ${JSON.stringify(participants)} ` +
        `(summary ${prepared.summaryMarkdown.length} chars, transcript ${prepared.transcriptText.length} chars, SSN redactions ${prepared.ssnRedactions})`
    );
    result.written.push({ id: file.id, title });
    return;
  }

  const existing = await deps.notion.rowsAtMinute(prepared.recorded);
  if (!st.summaryPageId) {
    const found = alreadyWritten(existing, TYPE_SUMMARY, title);
    st.summaryPageId = found
      ? found.id
      : (
          await deps.notion.createSummary(
            { title, recorded: prepared.recorded, type: TYPE_SUMMARY, participants },
            prepared.summaryMarkdown
          )
        ).id;
    deps.save();
  }
  if (!st.transcriptPageId) {
    const found = alreadyWritten(existing, TYPE_TRANSCRIPT, title);
    st.transcriptPageId = found
      ? found.id
      : (
          await deps.notion.createTranscript(
            { title, recorded: prepared.recorded, type: TYPE_TRANSCRIPT, participants },
            prepared.transcriptText
          )
        ).id;
  }
  st.status = "done";
  st.doneAt = now.toISOString();
  delete st.lastError;
  deps.save();
  result.written.push({ id: file.id, title });
  deps.log(`[${deps.profile}] wrote "${title}" (Recorded ${prepared.recorded}, participants ${JSON.stringify(participants)})`);
}

export async function runIngest(deps: IngestDeps, options: { deep?: boolean } = {}): Promise<IngestResult> {
  const now = (deps.now || (() => new Date()))();
  const result: IngestResult = { checked: 0, written: [], pending: 0, errors: [] };
  if (!deps.state.baselineAt) {
    await runBaseline(deps);
  }
  for (const file of await candidates(deps, options.deep === true)) {
    result.checked++;
    const st = (deps.state.files[file.id] ||= { status: "pending", firstSeen: now.toISOString(), llmAttempts: 0 });
    try {
      await processOne(deps, file, st, result);
    } catch (err) {
      st.lastError = safeErrorMessage(err);
      result.errors.push(`${file.name}: ${st.lastError}`);
      deps.save();
      // Auth problems affect every file; stop the cycle and let the daemon alert.
      const e = err as { unauthorized?: boolean; code?: string };
      if (e.unauthorized || e.code === "AUTH_EXPIRED") {
        throw err;
      }
    }
  }
  return result;
}
