/** Product constants. No secrets. */

export const PACKAGE_NAME = "plaud-notes-to-notion";
export const PACKAGE_VERSION = "0.0.0";

/** macOS Keychain service. One service, named accounts per profile. */
export const KEYCHAIN_SERVICE = "plaud-notes-to-notion";
/** Plaud OAuth token-set JSON for a profile: `plaud:<profile>`. */
export const plaudAccount = (profile: string): string => `plaud:${profile}`;
/** Notion integration token for a profile: `notion:<profile>`. */
export const notionAccount = (profile: string): string => `notion:${profile}`;
/** OpenAI API key. Shared unless a profile has its own `openai:<profile>`. */
export const OPENAI_ACCOUNT = "openai";
export const openaiAccount = (profile: string): string => `openai:${profile}`;

export const DEFAULT_POLL_SECONDS = 30;
export const DEFAULT_SYNC_SECONDS = 300;
/** Full Summary→Transcript reconcile window (matches the retired Grok routine). */
export const SYNC_FULL_WINDOW_DAYS = 90;
export const SYNC_FULL_EVERY_HOURS = 24;
/** Recordings waiting on Plaud are re-checked every poll for this long, then every 10 min. */
export const PENDING_FAST_HOURS = 48;
/** How far back deep scans and the cutover snapshot look for late summaries. */
export const WATCH_DAYS = 30;
/** Stop retrying the labeling call and write with Plaud's own title after this many failures. */
export const LLM_MAX_ATTEMPTS = 6;
export const STATE_KEEP_DAYS = 45;

export const DEFAULT_LLM_MODEL = "gpt-6-luna";
export const DEFAULT_LLM_EFFORT = "high";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Transcript characters sent to the labeler (names usually surface early). */
export const LLM_TRANSCRIPT_CHARS = 24_000;

/** Markdown page create/read needs this version; also used for queries and updates. */
export const NOTION_VERSION = "2026-03-11";
export const NOTION_TEXT_CHUNK = 2000;
export const NOTION_RICH_TEXT_PER_BLOCK = 100;

export const TYPE_SUMMARY = "Summary";
export const TYPE_TRANSCRIPT = "Transcript";

export const LAUNCHAGENT_LABEL = "com.plaud-notes-to-notion";
export const LOG_FILE_NAME = "plaud-notes-to-notion.log";
export const LOCK_FILE_NAME = "daemon.lock";

export const relogin = (profile: string): string =>
  `Plaud sign-in expired for profile ${profile}. Re-run: plaud-notes-to-notion login --profile ${profile}`;
export const RELLOGIN_NOTION = (profile: string): string =>
  `Notion token missing or rejected for profile ${profile}. Run: plaud-notes-to-notion set-secret notion --profile ${profile}  (and share the Plaud Notes database with that integration).`;
export const RELLOGIN_LLM =
  "OpenAI API key missing. Run: plaud-notes-to-notion set-secret openai  (or set OPENAI_API_KEY).";
