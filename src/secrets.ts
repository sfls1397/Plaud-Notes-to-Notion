import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KEYCHAIN_SERVICE } from "./constants.js";
import { getStateDir } from "./paths.js";

export type SecurityRunImpl = (
  bin: string,
  args: readonly string[],
  stdin?: string
) => Promise<{ stdout: string; stderr: string }>;

export const KEYCHAIN_WRITE_FAILED =
  "Keychain write failed. Run plaud-notes-to-notion from a logged-in GUI session on the Mini (SSH / non-GUI shells cannot write Keychain).";

function stripSecurityPassword(stdout: string): string {
  return stdout.replace(/\n$/, "");
}

/** Quote for `security -i` so the secret is on stdin, not `ps` argv. */
export function quoteSecurityArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function defaultSecurityRun(
  bin: string,
  args: readonly string[],
  stdin?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `security exited ${code}`));
    });
    if (!child.stdin) {
      reject(new Error(KEYCHAIN_WRITE_FAILED));
      return;
    }
    child.stdin.on("error", () => {
      /* EPIPE: close/error settles the promise */
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/**
 * Mini: `security -i` with the password on stdin (not argv / `ps`).
 * `-U` updates an existing item. GUI Terminal.app required — non-GUI write fails.
 */
export async function writeKeychainPassword(options: {
  service: string;
  account: string;
  value: string;
  securityBin?: string;
  securityRunImpl?: SecurityRunImpl;
}): Promise<void> {
  if (options.value.includes("\n") || options.value.includes("\r")) {
    throw new Error(KEYCHAIN_WRITE_FAILED);
  }
  const securityBin = options.securityBin || "/usr/bin/security";
  const run = options.securityRunImpl || defaultSecurityRun;
  const addLine = (update: boolean): string =>
    `add-generic-password${update ? " -U" : ""} -s ${quoteSecurityArg(options.service)} -a ${quoteSecurityArg(options.account)} -w ${quoteSecurityArg(options.value)}\n`;
  try {
    await run(securityBin, ["-i"], addLine(true));
  } catch {
    try {
      await run(securityBin, ["delete-generic-password", "-s", options.service, "-a", options.account]);
    } catch {
      /* nothing to replace */
    }
    try {
      await run(securityBin, ["-i"], addLine(false));
    } catch {
      throw new Error(KEYCHAIN_WRITE_FAILED);
    }
  }
  let readBack: string;
  try {
    const { stdout } = await run(securityBin, [
      "find-generic-password",
      "-s",
      options.service,
      "-a",
      options.account,
      "-w"
    ]);
    readBack = stripSecurityPassword(stdout);
  } catch {
    throw new Error(KEYCHAIN_WRITE_FAILED);
  }
  if (readBack !== options.value) {
    throw new Error(KEYCHAIN_WRITE_FAILED);
  }
}

export interface SecretStore {
  describe(): string;
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  describe(): string {
    return "in-memory store";
  }

  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

/** File-backed store for tests (`PLAUD_NOTES_HOME`) and Linux fallback. Mini uses Keychain. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  describe(): string {
    return `file store under ${path.join(this.dir, "secrets")}`;
  }

  private fileFor(account: string): string {
    const safe = account.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.dir, "secrets", safe);
  }

  async get(account: string): Promise<string | null> {
    try {
      const raw = await fs.promises.readFile(this.fileFor(account), "utf8");
      const trimmed = raw.trim();
      return trimmed ? trimmed : null;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async set(account: string, value: string): Promise<void> {
    const file = this.fileFor(account);
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, value, { encoding: "utf8", mode: 0o600 });
    await fs.promises.chmod(file, 0o600);
  }

  async delete(account: string): Promise<void> {
    try {
      await fs.promises.rm(this.fileFor(account));
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string = KEYCHAIN_SERVICE,
    private readonly securityBin: string = "/usr/bin/security",
    private readonly securityRunImpl: SecurityRunImpl = defaultSecurityRun
  ) {}

  describe(): string {
    return `macOS Keychain (service ${this.service})`;
  }

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await this.securityRunImpl(this.securityBin, [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        account,
        "-w"
      ]);
      const value = stripSecurityPassword(stdout);
      return value ? value : null;
    } catch {
      return null;
    }
  }

  async set(account: string, value: string): Promise<void> {
    await writeKeychainPassword({
      service: this.service,
      account,
      value,
      securityBin: this.securityBin,
      securityRunImpl: this.securityRunImpl
    });
  }

  async delete(account: string): Promise<void> {
    try {
      await this.securityRunImpl(this.securityBin, [
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        account
      ]);
    } catch {
      /* already gone */
    }
  }
}

export function createSecretStore(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): SecretStore {
  const env = options.env || process.env;
  if (env.PLAUD_NOTES_SECRET_STORE === "memory") {
    return new MemorySecretStore();
  }
  const platform = options.platform || process.platform;
  const home = env.PLAUD_NOTES_HOME && env.PLAUD_NOTES_HOME.trim();
  if (home) {
    return new FileSecretStore(path.resolve(home));
  }
  if (platform === "darwin") {
    return new KeychainSecretStore();
  }
  return new FileSecretStore(getStateDir(env));
}
