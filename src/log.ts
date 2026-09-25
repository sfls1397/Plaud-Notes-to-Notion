import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./redact.js";
import { ensureDir, getLogFilePath } from "./paths.js";

export interface Logger {
  verbose: boolean;
  info(msg: string): void;
  warn(msg: string): void;
  /** stderr gets `msg`. The Library/Logs file gets `fileLine` when provided (keep HTTP/network cause there). */
  error(msg: string, fileLine?: string): void;
}

export function createLogger(options: {
  verbose: boolean;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}): Logger {
  const env = options.env || process.env;
  const logFile = options.logFile || getLogFilePath(env);
  const stdout = options.stdout || ((s) => process.stdout.write(`${s}\n`));
  const stderr = options.stderr || ((s) => process.stderr.write(`${s}\n`));

  function append(line: string): void {
    try {
      ensureDir(path.dirname(logFile));
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${redactSecrets(line)}\n`);
    } catch {
      /* logging must not crash the run */
    }
  }

  return {
    verbose: options.verbose,
    info(msg: string) {
      const line = redactSecrets(msg);
      append(`INFO ${line}`);
      if (options.verbose) {
        stdout(line);
      }
    },
    warn(msg: string) {
      const line = redactSecrets(msg);
      append(`WARN ${line}`);
      stderr(line);
    },
    error(msg: string, fileLine?: string) {
      const line = redactSecrets(msg);
      const forFile = redactSecrets((fileLine || msg).trim() || msg);
      append(`ERROR ${forFile}`);
      stderr(line);
    }
  };
}
