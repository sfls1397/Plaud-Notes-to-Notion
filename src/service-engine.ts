import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAnthropicModel } from "./constants.js";

export interface ServiceSelection {
  readonly engine: "sol" | "claude";
  readonly generation: string;
  readonly claudeApi?: true;
}

export class ServiceModelError extends Error {
  constructor(message: string, readonly usageLimit = false) {
    super(message);
    this.name = "ServiceModelError";
  }
}

export function serviceSelection(env: NodeJS.ProcessEnv = process.env): ServiceSelection {
  const file = env.TOOLBOX_SERVICE_ENGINE_FILE || path.join(os.homedir(), ".toolbox", "service-engine.json");
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ engine: "claude", generation: "baseline" });
    }
    throw new ServiceModelError("Service engine policy is unreadable");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 8192) throw new Error();
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!value || value.version !== 1 || !["sol", "claude"].includes(value.engine)
        || typeof value.generation !== "string" || !value.generation
        || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) throw new Error();
    return Object.freeze({ engine: value.engine, generation: value.generation });
  } catch {
    throw new ServiceModelError("Service engine policy is invalid");
  } finally {
    fs.closeSync(descriptor);
  }
}

function useClaudeApi(env: NodeJS.ProcessEnv): boolean {
  const file = path.join(env.HOME || os.homedir(), ".toolbox", "claude-service-billing-plaud");
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ServiceModelError("Claude service billing policy is unreadable");
  }
  try {
    const marker = "claude-api\n";
    const stat = fs.fstatSync(descriptor);
    const data = Buffer.alloc(marker.length + 1);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())
        || stat.size !== marker.length || fs.readSync(descriptor, data, 0, data.length, 0) !== marker.length
        || data.toString("utf8", 0, marker.length) !== marker) throw new Error();
    return true;
  } catch {
    throw new ServiceModelError("Claude service billing policy is invalid");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function labelerSelection(model: string, env: NodeJS.ProcessEnv = process.env): ServiceSelection {
  const selection = serviceSelection(env);
  if (selection.engine !== "claude" || !isAnthropicModel(model) || !useClaudeApi(env)) return selection;
  return Object.freeze({ ...selection, claudeApi: true });
}

export interface ServiceRequest {
  service: string;
  system: string;
  prompt: string;
  schema: object;
  timeoutMs?: number;
}

export function serviceModel(request: ServiceRequest, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const timeoutMs = request.timeoutMs ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    return Promise.reject(new ServiceModelError("Invalid service model timeout"));
  }
  const input = JSON.stringify({ version: 1, service: request.service, system: request.system,
    prompt: request.prompt, schema: request.schema, timeout_ms: timeoutMs });
  const bound = 2 * 1024 * 1024;
  if (Buffer.byteLength(input) > bound) return Promise.reject(new ServiceModelError("Service request exceeded bound"));
  return new Promise((resolve, reject) => {
    const binary = env.TOOLBOX_SERVICE_MODEL_BIN || path.join(os.homedir(), ".local", "bin", "service-model");
    const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
      !/^(?:NOTION_TOKEN|(?:OPENAI|ANTHROPIC)_API_KEY)/i.test(name)));
    const child = spawn(binary, ["codex"], { env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: ServiceModelError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch {}
    };
    const stop = (message: string) => {
      if (failure) return;
      failure ??= new ServiceModelError(message);
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => stop("Service model timed out"), timeoutMs + 2000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > bound) stop("Service response exceeded bound");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > bound) stop("Service response exceeded bound");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      reject(new ServiceModelError("Service model transport unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      kill("SIGKILL");
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ServiceModelError(code === 2 ? "Codex subscription usage limit" : "Service model failed", code === 2));
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!reply || reply.version !== 1 || reply.engine !== "codex" || reply.model !== "gpt-6.1-sol"
            || typeof reply.text !== "string" || !reply.text.trim()) throw new Error();
        resolve(reply.text);
      } catch {
        reject(new ServiceModelError("Invalid service model response"));
      }
    });
    child.stdin.end(input);
  });
}
