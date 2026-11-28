import fs from "node:fs";
import { claudeBinary } from "./claude-subscription.js";
import { spawn } from "node:child_process";
import type { AppConfig, ProfileConfig } from "./config.js";
import {
  ANTHROPIC_ACCOUNT,
  OPENAI_ACCOUNT,
  RELLOGIN_ANTHROPIC,
  RELLOGIN_LLM,
  RELLOGIN_NOTION,
  anthropicAccount,
  isAnthropicModel,
  notionAccount,
  openaiAccount,
  plaudAccount,
  relogin
} from "./constants.js";
import { AnthropicLabeler, createLabeler, solLabeler, type Labeler } from "./llm.js";
import { labelerSelection, type ServiceSelection } from "./service-engine.js";
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

export async function anthropicKey(store: SecretStore, credentials: string, env: NodeJS.ProcessEnv): Promise<string> {
  const key =
    (await readSecret(store, anthropicAccount(credentials), env)) || (await readSecret(store, ANTHROPIC_ACCOUNT, env));
  if (!key) {
    throw new SetupError(RELLOGIN_ANTHROPIC);
  }
  return key;
}

export async function anthropicFallbackKey(store: SecretStore, credentials: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await readSecret(store, anthropicAccount(credentials), env)) || (await readSecret(store, ANTHROPIC_ACCOUNT, env)) || undefined;
}

export function requireClaudeCode(env: NodeJS.ProcessEnv): void {
  const bin = claudeBinary(env);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    throw new SetupError(`Claude Code is not runnable at ${bin}. Claude models run on the Claude subscription: install Claude Code and sign it in with \`claude /login\` (the Anthropic key is only the fallback for its usage limit).`);
  }
}

export async function llmKey(store: SecretStore, credentials: string, model: string, env: NodeJS.ProcessEnv): Promise<string> {
  return isAnthropicModel(model) ? anthropicKey(store, credentials, env) : openaiKey(store, credentials, env);
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
    const selection = options.selection || labelerSelection(options.config.llmModel, env);
    if (selection.engine === "sol") {
      labeler = solLabeler(env);
    } else if (selection.claudeApi) {
      labeler = new AnthropicLabeler({
        apiKey: await anthropicKey(options.store, creds, env),
        model: options.config.llmModel,
        baseUrl: options.config.anthropicBaseUrl,
        env
      });
    } else {
      const { llmModel, llmEffort, openaiBaseUrl, anthropicBaseUrl } = options.config;
      const claude = isAnthropicModel(llmModel);
      if (claude) requireClaudeCode(env);
      const apiKey = claude && !selection.subscriptionOnly ? await anthropicFallbackKey(options.store, creds, env) : undefined;
      labeler = createLabeler({
        model: llmModel,
        effort: llmEffort,
        openaiKey: claude ? undefined : await openaiKey(options.store, creds, env),
        anthropicKey: apiKey,
        openaiBaseUrl,
        anthropicBaseUrl,
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
  }
}
