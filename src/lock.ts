import fs from "node:fs";
import path from "node:path";

export interface LockData {
  pid: number;
  timestamp: number;
  raw: string;
}

export function isProcessAlive(
  pid: number,
  killFn: (pid: number, signal: number) => void = (p, signal) => {
    process.kill(p, signal);
  }
): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseLockData(text: unknown): LockData | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const [pidStr, timestampStr] = text.split(":");
  const pid = parseInt(pidStr, 10);
  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    timestamp: Number.isInteger(timestamp) ? timestamp : 0,
    raw: text
  };
}

export function formatLockData(pid: number, timestamp: number): string {
  return `${pid}:${timestamp}`;
}

export interface JobLock {
  acquire(): boolean;
  release(): void;
  readonly ownsLock: boolean;
}

/**
 * Exclusive job.lock. A live holder is never displaced (skip-if-already-running).
 * Dead-PID takeover uses wx-create so a peer's freshly written lock is not deleted.
 */
export function createJobLock(options: {
  lockFile: string;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  fsApi?: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync" | "unlinkSync" | "mkdirSync">;
  log?: (msg: string) => void;
}): JobLock {
  const lockFile = options.lockFile;
  const pid = options.pid ?? process.pid;
  const now = options.now || (() => Date.now());
  const isAlive = options.isAlive || ((holderPid) => isProcessAlive(holderPid));
  const fsApi = options.fsApi || fs;
  const log = options.log || ((msg) => console.error(msg));

  let ownsLock = false;

  function readLockFile(): string | null {
    if (!fsApi.existsSync(lockFile)) {
      return null;
    }
    return fsApi.readFileSync(lockFile, "utf8");
  }

  function acquire(): boolean {
    try {
      const lockDir = path.dirname(lockFile);
      if (!fsApi.existsSync(lockDir)) {
        fsApi.mkdirSync(lockDir, { recursive: true });
      }

      const existing = readLockFile();
      if (existing !== null) {
        const parsed = parseLockData(existing);
        if (!parsed) {
          ownsLock = false;
          return false;
        }
        if (parsed.pid === pid) {
          ownsLock = true;
          fsApi.writeFileSync(lockFile, formatLockData(pid, now()));
          return true;
        }
        if (isAlive(parsed.pid)) {
          log(`Another instance running (PID ${parsed.pid}). Skipping.`);
          ownsLock = false;
          return false;
        }
        const again = readLockFile();
        if (again !== existing) {
          ownsLock = false;
          return false;
        }
        try {
          fsApi.unlinkSync(lockFile);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            throw err;
          }
        }
        log(`Removing stale lock file (PID ${parsed.pid} not running)`);
      }

      try {
        fsApi.writeFileSync(lockFile, formatLockData(pid, now()), { flag: "wx" });
        ownsLock = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          log("Another process acquired lock during race. Skipping.");
          ownsLock = false;
          return false;
        }
        throw err;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Lock file error: ${message}`);
      ownsLock = false;
      return false;
    }
  }

  function release(): void {
    try {
      const lockData = readLockFile();
      if (lockData) {
        const parsed = parseLockData(lockData);
        if (parsed && parsed.pid === pid) {
          fsApi.unlinkSync(lockFile);
          ownsLock = false;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    acquire,
    release,
    get ownsLock() {
      return ownsLock;
    }
  };
}
