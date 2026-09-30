import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_LLM_EFFORT,
  DEFAULT_LLM_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_POLL_SECONDS,
  DEFAULT_SYNC_SECONDS
} from "./constants.js";
import { getConfigPath, readJson, writeJsonAtomic } from "./paths.js";

/**
 * One Plaud account → one Plaud Notes database. Peter and Tim are identical
 * except for these fields; everything else (pipeline, prompt, schedule) is shared.
 */
export interface ProfileConfig {
  /** Off = never polled or synced. */
  enabled: boolean;
  /** Recorder owner. Never listed in Participants; named in the labeling prompt. */
  owner: string;
  /** Plaud Notes data source id (collection://…) in that person's Notion. */
  notionDataSourceId: string;
  /**
   * Only recordings uploaded to Plaud at/after this instant are ingested.
   * Set at cutover so recordings the Zap already wrote are not re-processed.
   */
  startAfter: string;
  /** Poll Plaud and write new Summary/Transcript rows. */
  ingest: boolean;
  /** Run the 5-minute Summary→Transcript alignment for this profile. */
  syncTranscripts: boolean;
  /**
   * Keychain profile whose Plaud/Notion secrets this profile uses (default: itself).
   * Lets a test profile share Peter's sign-in while writing to a test database.
   */
  credentials: string;
}

export interface AppConfig {
  pollSeconds: number;
  syncSeconds: number;
  llmModel: string;
  llmEffort: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  profiles: Record<string, ProfileConfig>;
}

export const DEFAULT_CONFIG: AppConfig = {
  pollSeconds: DEFAULT_POLL_SECONDS,
  syncSeconds: DEFAULT_SYNC_SECONDS,
  llmModel: DEFAULT_LLM_MODEL,
  llmEffort: DEFAULT_LLM_EFFORT,
  openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
  anthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
  profiles: {}
};

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, v));
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function normalizeId(raw: string): string {
  const hex = raw.replace(/^collection:\/\//, "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Not a Notion id: ${raw}`);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseConfig(raw: unknown): AppConfig {
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const profilesRaw = (rec.profiles && typeof rec.profiles === "object" ? rec.profiles : {}) as Record<string, unknown>;
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, value] of Object.entries(profilesRaw)) {
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new Error(`Profile name must be lowercase letters, digits, - or _: ${name}`);
    }
    const p = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (typeof p.owner !== "string" || !p.owner.trim()) {
      throw new Error(`Profile ${name}: owner is required`);
    }
    if (typeof p.notionDataSourceId !== "string") {
      throw new Error(`Profile ${name}: notionDataSourceId is required`);
    }
    if (!isIsoInstant(p.startAfter)) {
      throw new Error(`Profile ${name}: startAfter must be an ISO date-time`);
    }
    profiles[name] = {
      enabled: p.enabled === true,
      owner: p.owner.trim(),
      notionDataSourceId: normalizeId(p.notionDataSourceId),
      startAfter: new Date(p.startAfter).toISOString(),
      ingest: p.ingest !== false,
      syncTranscripts: p.syncTranscripts !== false,
      credentials: typeof p.credentials === "string" && /^[a-z0-9_-]+$/.test(p.credentials) ? p.credentials : name
    };
  }
  return {
    pollSeconds: clamp(rec.pollSeconds, 10, 3600, DEFAULT_CONFIG.pollSeconds),
    syncSeconds: clamp(rec.syncSeconds, 60, 86_400, DEFAULT_CONFIG.syncSeconds),
    llmModel: typeof rec.llmModel === "string" && rec.llmModel.trim() ? rec.llmModel.trim() : DEFAULT_CONFIG.llmModel,
    llmEffort:
      typeof rec.llmEffort === "string" && rec.llmEffort.trim() ? rec.llmEffort.trim() : DEFAULT_CONFIG.llmEffort,
    openaiBaseUrl:
      typeof rec.openaiBaseUrl === "string" && rec.openaiBaseUrl.trim()
        ? rec.openaiBaseUrl.trim()
        : DEFAULT_CONFIG.openaiBaseUrl,
    anthropicBaseUrl:
      typeof rec.anthropicBaseUrl === "string" && rec.anthropicBaseUrl.trim()
        ? rec.anthropicBaseUrl.trim()
        : DEFAULT_CONFIG.anthropicBaseUrl,
    profiles
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = readJson<unknown>(getConfigPath(env));
  if (raw === null) {
    throw new Error(`No config at ${getConfigPath(env)}. Run: plaud-notes-to-notion init`);
  }
  return parseConfig(raw);
}

export function saveConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(getConfigPath(env), config);
}

export function getProfile(config: AppConfig, name: string): ProfileConfig {
  const p = config.profiles[name];
  if (!p) {
    throw new Error(`Unknown profile "${name}". Known: ${Object.keys(config.profiles).join(", ") || "(none)"}`);
  }
  return p;
}
