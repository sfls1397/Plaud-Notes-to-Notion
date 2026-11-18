import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Haiku through the Claude subscription: headless Claude Code (`claude -p`)
 * signed in to the subscription, never an Anthropic API key (Peter, 11:08 PM CT
 * Nov 17 2026). The caller may fall back to the Claude API only when this reports
 * the subscription's usage limit (Peter, 11:58 PM CT Nov 17 2026).
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
/** Claude Code saying a throttle is not the plan's limit ("Server is temporarily limiting requests (not your usage limit)"). */
const NOT_LIMIT = /not your usage limit|temporarily limiting requests/i;
/**
 * The plan's own usage limit, worded as Toolbox claude-side's USAGE_LIMIT (lib/claude_side.py): only this may move a
 * call to the Claude API. A bare 429, "rate limit" or "too many requests" is a one-time failure, never a fallback
 * (Peter: never fall back to the API on a one-time failure; 8:53 AM CT Nov 11 2026).
 */
const PLAN_LIMIT = /hit your (?:(?:weekly|opus|sonnet|fable|haiku|usage credit|monthly spend)\s+)?limit\b|reached your (?:weekly |monthly )?usage limit|weekly limit|usage[_ ]limit|out of (?:extra )?usage\b|out of usage credits/i;
/** A short-window limit (5-hour, session): the call waits for it, but it never moves to the Claude API (as claude-side). */
const WINDOW_LIMIT = /\b\d+-hour limit\b|\bsession limit\b/i;
const OUTPUT_BOUND = 8 * 1024 * 1024;

export class ClaudeSubscriptionError extends Error {
  /**
   * usageLimit: the subscription is at a limit, so the work waits for it (no attempt spent).
   * planLimit: that limit is the plan's own usage limit, the only one a caller may answer with the Claude API.
   */
  constructor(message: string, readonly usageLimit = false, readonly planLimit = false) {
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

/** Classify Claude Code's own failure words: the plan's usage limit, a short-window limit, or neither. */
export function limitOf(text: string): "plan" | "window" | null {
  if (NOT_LIMIT.test(text)) return null;
  if (PLAN_LIMIT.test(text)) return "plan";
  if (WINDOW_LIMIT.test(text)) return "window";
  return null;
}

function limitError(kind: "plan" | "window"): ClaudeSubscriptionError {
  return kind === "plan"
    ? new ClaudeSubscriptionError("Claude subscription usage limit", true, true)
    : new ClaudeSubscriptionError("Claude subscription session limit", true, false);
}

/** The reply text (the structured JSON, encoded) from one finished `claude -p` run. Throws on anything else. */
export function readReply(model: string, code: number | null, stdout: string, stderr: string): string {
  const { init, result } = eventsOf(stdout);
  if (result?.is_error) {
    const kind = limitOf(`${String(result.result ?? "")}\n${String(result.api_error ?? "")}`);
    if (kind) throw limitError(kind);
    throw new ClaudeSubscriptionError("Claude subscription call failed");
  }
  if (!result) {
    // Like claude-side: only stderr and the last plain-text stdout line are Claude Code's own words.
    const plain = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = plain.length && !plain[plain.length - 1].startsWith("{") ? plain[plain.length - 1] : "";
    const kind = code === 0 ? null : limitOf(`${stderr}\n${last}`);
    if (kind) throw limitError(kind);
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
