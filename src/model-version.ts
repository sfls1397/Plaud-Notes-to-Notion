import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isModelFamily } from "./constants.js";

export type ModelRoute = "claude" | "claude-api";
export type ModelFamily = "opus" | "sonnet" | "haiku";

export class ModelResolveError extends Error {
  constructor(
    readonly route: string,
    readonly family: string,
    readonly reason: string
  ) {
    super(`Cannot resolve the newest model for route ${route}, family ${family}: ${reason}`);
    this.name = "ModelResolveError";
  }
}

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 2;
const SECRET_ENV = /^(?:NOTION_TOKEN|(?:OPENAI|ANTHROPIC)_API_KEY)/i;

export function resolverBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOOLBOX_MODEL_VERSIONS_BIN?.trim() || path.join(env.HOME || os.homedir(), ".toolbox", "runner", "bin", "model-versions");
}

function attempt(route: ModelRoute, family: ModelFamily, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const binary = resolverBinary(env);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
  return new Promise((resolve, reject) => {
    execFile(binary, ["resolve", route, family],
      { env: childEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean };
          if (failure.killed) return reject(new ModelResolveError(route, family, `resolver timed out after ${timeoutMs} ms`));
          if (failure.code === "ENOENT" || failure.code === "EACCES") {
            return reject(new ModelResolveError(route, family, `resolver not runnable at ${binary}`));
          }
          const detail = stderr.trim().split("\n")[0]?.slice(0, 200);
          return reject(new ModelResolveError(route, family, detail || `resolver exited ${String(failure.code ?? "abnormally")}`));
        }
        const model = stdout.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(model)) {
          return reject(new ModelResolveError(route, family, "resolver printed no usable model id"));
        }
        if (!new RegExp(`^claude-(?:.+-)?${family}(?:-|$)`).test(model)) {
          return reject(new ModelResolveError(route, family, `resolver returned "${model}", which is not a ${family} model`));
        }
        resolve(model);
      });
  });
}

export async function resolveModel(
  route: ModelRoute,
  family: ModelFamily,
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  let last: ModelResolveError | undefined;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return await attempt(route, family, env, options.timeoutMs ?? TIMEOUT_MS);
    } catch (error) {
      last = error as ModelResolveError;
    }
  }
  throw last as ModelResolveError;
}

export function launchModel(route: ModelRoute, configured: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return isModelFamily(configured) ? resolveModel(route, configured.trim().toLowerCase() as ModelFamily, env) : Promise.resolve(configured);
}

export async function describeModel(route: ModelRoute, configured: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return isModelFamily(configured) ? `${configured} -> ${await launchModel(route, configured, env)}` : configured;
}
