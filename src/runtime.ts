import { spawn } from "node:child_process";
import type { AppConfig, ProfileConfig } from "./config.js";
import {
  OPENAI_ACCOUNT,
  RELLOGIN_LLM,
  RELLOGIN_NOTION,
  isClaudeModel,
  notionAccount,
  openaiAccount,
  plaudAccount,
  relogin
} from "./constants.js";
import { createLabeler, solLabeler, type Labeler } from "./llm.js";
import { serviceSelection, type ServiceSelection } from "./service-engine.js";
import { HttpNotionStore, type NotionStore } from "./notion.js";
import { getStatusPath, readJson, writeJsonAtomic } from "./paths.js";
import { HttpPlaudClient, type PlaudClient } from "./plaud/client.js";
import { createAuthSession } from "./plaud/session.js";
import { readSecret, type SecretStore } from "./secrets.js";

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export interface ProfileRuntime {
  plaud: PlaudClient;
  notion: NotionStore;
  labeler: Labeler;
}

export async function openaiKey(store: SecretStore, credentials: string, env: NodeJS.ProcessEnv): Promise<string> {
  const key = (await readSecret(store, openaiAccount(credentials), env)) || (await readSecret(store, OPENAI_ACCOUNT, env));
  if (!key) {
    throw new SetupError(RELLOGIN_LLM);
  }
  return key;
}

/**
 * The API key a non-Claude model needs (OpenAI). A Claude model runs on the Claude
 * subscription and needs no key, so none is read for it: undefined.
 */
export async function llmKey(store: SecretStore, credentials: string, model: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return isClaudeModel(model) ? undefined : openaiKey(store, credentials, env);
}

export async function buildProfileRuntime(options: {
  name: string;
  profile: ProfileConfig;
  config: AppConfig;
  store: SecretStore;
  env?: NodeJS.ProcessEnv;
  needPlaud: boolean;
  needLabeler: boolean;
  selection?: ServiceSelection;
}): Promise<ProfileRuntime> {
  const env = options.env || process.env;
  const creds = options.profile.credentials;
  const notionToken = await readSecret(options.store, notionAccount(creds), env);
  if (!notionToken) {
    throw new SetupError(RELLOGIN_NOTION(creds));
  }
  const notion = new HttpNotionStore({ token: notionToken, dataSourceId: options.profile.notionDataSourceId });

  let plaud: PlaudClient = {
    listFiles: () => Promise.reject(new SetupError("Plaud not needed for this command")),
    getRecording: () => Promise.reject(new SetupError("Plaud not needed for this command")),
    currentUser: () => Promise.reject(new SetupError("Plaud not needed for this command"))
  };
  if (options.needPlaud) {
    const session = await createAuthSession({ store: options.store, account: plaudAccount(creds), env });
    if (!session.peek()) {
      throw new SetupError(relogin(creds));
    }
    plaud = new HttpPlaudClient(session);
  }

  let labeler: Labeler = { label: () => Promise.reject(new SetupError("Labeler not needed for this command")) };
  if (options.needLabeler) {
    const selection = options.selection || serviceSelection(env);
    if (selection.engine === "sol") {
      labeler = solLabeler(env);
    } else {
      const { llmModel, llmEffort, openaiBaseUrl } = options.config;
      labeler = createLabeler({
        model: llmModel,
        effort: llmEffort,
        openaiKey: await llmKey(options.store, creds, llmModel, env),
        openaiBaseUrl,
        env
      });
    }
  }
  return { plaud, notion, labeler };
}

export interface ProfileStatus {
  lastPollAt?: string;
  lastPollOkAt?: string;
  lastSyncOkAt?: string;
  lastWritten?: { title: string; at: string };
  pending?: number;
  lastError?: string;
  lastErrorAt?: string;
  alertedAt?: string;
}

export type StatusFile = Record<string, ProfileStatus>;

export function readStatus(env: NodeJS.ProcessEnv = process.env): StatusFile {
  return readJson<StatusFile>(getStatusPath(env)) || {};
}

export function updateStatus(profile: string, patch: Partial<ProfileStatus>, env: NodeJS.ProcessEnv = process.env): ProfileStatus {
  const all = readStatus(env);
  const next = { ...(all[profile] || {}), ...patch };
  all[profile] = next;
  writeJsonAtomic(getStatusPath(env), all);
  return next;
}

/** macOS banner so an expired sign-in never fails silently. Best effort. */
export function notifyMac(title: string, message: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const child = spawn("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], {
      stdio: "ignore",
      detached: true
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
