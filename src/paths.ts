import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCK_FILE_NAME, LOG_FILE_NAME, PACKAGE_NAME } from "./constants.js";

export function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PLAUD_NOTES_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return os.homedir();
}

export function getStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getHomeDir(env), `.${PACKAGE_NAME}`);
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getStateDir(env), "config.json");
}

export function getProfileStatePath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getStateDir(env), "state", `${profile}.json`);
}

export function getStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getStateDir(env), "status.json");
}

export function getLockFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getStateDir(env), LOCK_FILE_NAME);
}

export function getLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getHomeDir(env), "Library", "Logs", LOG_FILE_NAME);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write JSON atomically (tmp + rename) so a crash never leaves half a state file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
