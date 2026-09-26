import { STATE_KEEP_DAYS } from "./constants.js";
import { getProfileStatePath, readJson, writeJsonAtomic } from "./paths.js";

export interface FileState {
  /** baseline = finished before cutover (the Zap's); pending = waiting on Plaud or a retry. */
  status: "pending" | "done" | "baseline";
  /** Waiting longer than PENDING_FAST_HOURS: re-checked on deep scans only. */
  slow?: boolean;
  firstSeen: string;
  name?: string;
  recorded?: string;
  /** Labels are computed once and reused on retries so Summary and Transcript always match. */
  title?: string;
  participants?: string[];
  labelSource?: "llm" | "fallback";
  llmAttempts: number;
  summaryPageId?: string;
  transcriptPageId?: string;
  ssnRedactions?: number;
  lastError?: string;
  doneAt?: string;
}

export interface ProfileState {
  version: 1;
  files: Record<string, FileState>;
  lastSyncAt?: string;
  lastFullSyncAt?: string;
  /** When the one-time cutover snapshot ran. */
  baselineAt?: string;
  /**
   * Summary page id → its Transcript sibling, as last seen live. Lets the sync
   * notice a Summary that was moved to the trash and trash its Transcript too.
   */
  pairs?: Record<string, PairState>;
}

export interface PairState {
  transcriptId: string;
  minute: string;
  /** Set when the service trashed the Transcript because its Summary was trashed. */
  trashedAt?: string;
}

export function emptyState(): ProfileState {
  return { version: 1, files: {} };
}

export function loadState(profile: string, env: NodeJS.ProcessEnv = process.env): ProfileState {
  const raw = readJson<ProfileState>(getProfileStatePath(profile, env));
  return raw && raw.version === 1 && raw.files ? raw : emptyState();
}

export function saveState(profile: string, state: ProfileState, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(getProfileStatePath(profile, env), state);
}

/** Forget finished files after a month; the startAfter watermark keeps them from coming back. */
export function pruneState(state: ProfileState, now: Date): void {
  const cutoff = now.getTime() - STATE_KEEP_DAYS * 86_400_000;
  for (const [id, f] of Object.entries(state.files)) {
    const at = Date.parse(f.doneAt || f.firstSeen);
    if (f.status !== "pending" && Number.isFinite(at) && at < cutoff) {
      delete state.files[id];
    }
  }
}
