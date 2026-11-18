import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Haiku through the Claude subscription: headless Claude Code (`claude -p`)
 * signed in to the subscription, never an Anthropic API key (Peter: everything
 * using the Claude API moves to the Claude subscription, no exceptions; 11:08 PM CT
 * Nov 17 2026).
 *
 * Three guards keep a key out of every call:
 * 1. The child gets an allowlisted environment, so no ANTHROPIC_API_KEY,
 *    ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_TOKEN or cloud
 *    provider switch reaches it, whatever the parent was handed.
 * 2. `--setting-sources ""` skips every settings file, so no apiKeyHelper or env
 *    block from a settings file can supply one.
 * 3. The reply is accepted only when Claude Code's own init event reports
 *    `apiKeySource: "none"` (the subscription sign-in) and every model it used is Haiku.
 */

export const SUBSCRIPTION_ENV_KEEP = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "TZ"] as const;
const HAIKU = /^claude-haiku-\d[a-z0-9.-]*$/;
const LIMIT = /usage[_ ]limit|rate[_ -]?limit|hit your .{0,40}limit|\b\d+-hour limit\b|weekly limit|too many requests|\b429\b|out of (?:extra )?usage/i;
const OUTPUT_BOUND = 8 * 1024 * 1024;

export class ClaudeSubscriptionError extends Error {
  constructor(message: string, readonly usageLimit = false) {
    super(message);
    this.name = "ClaudeSubscriptionError";
  }
}

export interface ClaudeSubscriptionRequest {
  model: string;
  system: string;
  prompt: string;
  schema: object;
  timeoutMs?: number;
  effort?: "low" | "medium" | "high";
}

export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of SUBSCRIPTION_ENV_KEEP) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  // Claude Code finds its subscription sign-in in the login Keychain by USER; a LaunchAgent's
  // environment may not carry it ("Not logged in"), so take it from the OS account.
  if (!out.USER || !out.LOGNAME) {
    let account = "";
    try {
      account = os.userInfo().username;
    } catch {
      // no account name available; Claude Code then reports "Not logged in"
    }
    if (account) {
      out.USER ||= account;
      out.LOGNAME ||= account;
    }
  }
  return out;
}

export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SUBSCRIPTION_BIN?.trim() || path.join(env.HOME || os.homedir(), ".local", "bin", "claude");
}

export function subscriptionArgs(request: ClaudeSubscriptionRequest): string[] {
  return [
    "-p",
    "--model", request.model,
    "--effort", request.effort ?? "high",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt", request.system,
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(request.schema)
  ];
}

interface Events {
  init?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function eventsOf(stdout: string): Events {
  const found: Events = {};
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type === "system" && record.subtype === "init") found.init = record;
    if (record.type === "result") found.result = record;
  }
  return found;
}

/** The reply text (the structured JSON, encoded) from one finished `claude -p` run. Throws on anything else. */
export function readReply(model: string, code: number | null, stdout: string, stderr: string): string {
  const { init, result } = eventsOf(stdout);
  if (result?.is_error) {
    const message = `${String(result.result ?? "")}\n${String(result.api_error ?? "")}`;
    if (result.api_error_status === 429 || LIMIT.test(message)) {
      throw new ClaudeSubscriptionError("Claude subscription usage limit", true);
    }
    throw new ClaudeSubscriptionError("Claude subscription call failed");
  }
  if (!result) {
    if (LIMIT.test(`${stderr}\n${stdout.split("\n").filter((l) => !l.trim().startsWith("{")).join("\n")}`)) {
      throw new ClaudeSubscriptionError("Claude subscription usage limit", true);
    }
    throw new ClaudeSubscriptionError(`Claude subscription call failed (exit ${code ?? "signal"})`);
  }
  if (!init || init.apiKeySource !== "none") {
    throw new ClaudeSubscriptionError("Claude Code was not on the Claude subscription (an API key was in use); reply refused");
  }
  if (init.model !== model) {
    throw new ClaudeSubscriptionError("Claude Code ran a different model than requested; reply refused");
  }
  const used = Object.keys((result.modelUsage as Record<string, unknown> | undefined) || {});
  if (used.some((name) => !HAIKU.test(name))) {
    throw new ClaudeSubscriptionError("Claude Code used a model other than Haiku; reply refused");
  }
  if (code !== 0) {
    throw new ClaudeSubscriptionError(`Claude subscription call failed (exit ${code ?? "signal"})`);
  }
  const structured = result.structured_output;
  const text = structured && typeof structured === "object" ? JSON.stringify(structured) : String(result.result ?? "");
  if (!text.trim()) throw new ClaudeSubscriptionError("Claude subscription returned an empty reply");
  return text;
}

export function claudeSubscription(request: ClaudeSubscriptionRequest, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!HAIKU.test(request.model)) {
    return Promise.reject(new ClaudeSubscriptionError(`Only Claude Haiku runs on the Claude subscription here, not ${request.model}`));
  }
  const timeoutMs = request.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    return Promise.reject(new ClaudeSubscriptionError("Invalid Claude subscription timeout"));
  }
  const childEnv = subscriptionEnv(env);
  const binary = claudeBinary(env);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "claude-subscription-"));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, subscriptionArgs(request), { cwd: work, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let failure: ClaudeSubscriptionError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = new ClaudeSubscriptionError(message);
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => stop(`Claude subscription call timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BOUND) stop("Claude subscription reply exceeded its bound");
      else into.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.stdin.on("error", () => {});
    const done = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      fs.rmSync(work, { recursive: true, force: true });
    };
    child.on("error", () => {
      done();
      reject(new ClaudeSubscriptionError(`Claude Code is not runnable at ${binary}`));
    });
    child.on("close", (code) => {
      done();
      kill("SIGKILL");
      if (failure) return reject(failure);
      try {
        resolve(readReply(request.model, code, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(request.prompt);
  });
}
