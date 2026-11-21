import { readFileSync } from "node:fs";

export const PACKAGE_NAME = "plaud-notes-to-notion";
export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

export const KEYCHAIN_SERVICE = "plaud-notes-to-notion";
export const plaudAccount = (profile: string): string => `plaud:${profile}`;
export const notionAccount = (profile: string): string => `notion:${profile}`;
export const OPENAI_ACCOUNT = "openai";
export const openaiAccount = (profile: string): string => `openai:${profile}`;
export const ANTHROPIC_ACCOUNT = "anthropic";
export const anthropicAccount = (profile: string): string => `anthropic:${profile}`;

export const DEFAULT_POLL_SECONDS = 30;
export const DEFAULT_SYNC_SECONDS = 300;
export const SYNC_FULL_WINDOW_DAYS = 90;
export const SYNC_FULL_EVERY_HOURS = 24;
export const PENDING_FAST_HOURS = 48;
export const WATCH_DAYS = 30;
export const LLM_MAX_ATTEMPTS = 6;
export const STATE_KEEP_DAYS = 45;

export const DEFAULT_LLM_MODEL = "claude-haiku-5-5";
export const DEFAULT_LLM_EFFORT = "high";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const isAnthropicModel = (model: string): boolean => /^claude-/i.test(model.trim());
export const LLM_TRANSCRIPT_CHARS = 24_000;

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
export const RELLOGIN_ANTHROPIC =
  "Anthropic API key missing. Run: plaud-notes-to-notion set-secret anthropic  (or set ANTHROPIC_API_KEY).";
export const relloginLlmFor = (model: string): string => (isAnthropicModel(model) ? RELLOGIN_ANTHROPIC : RELLOGIN_LLM);
