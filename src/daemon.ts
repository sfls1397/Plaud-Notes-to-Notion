import fs from "node:fs";
import { loadConfig, type AppConfig } from "./config.js";
import { relogin, RELLOGIN_NOTION } from "./constants.js";
import { runIngest } from "./ingest.js";
import { createJobLock } from "./lock.js";
import type { Logger } from "./log.js";
import { NotionError } from "./notion.js";
import { getConfigPath, getLockFilePath } from "./paths.js";
import { isAuthExpiredError, isTransportError } from "./plaud/errors.js";
import { safeErrorMessage } from "./redact.js";
import { buildProfileRuntime, notifyMac, readStatus, SetupError, updateStatus, type ProfileRuntime } from "./runtime.js";
import type { SecretStore } from "./secrets.js";
import { loadState, pruneState, saveState } from "./state.js";
import { runSync } from "./sync.js";

const DEEP_SCAN_EVERY_MS = 10 * 60_000;
const ALERT_EVERY_MS = 6 * 3_600_000;
const RUNTIME_RETRY_MS = 5 * 60_000;

interface ProfileTimers {
  nextPoll: number;
  nextSync: number;
  nextDeep: number;
  runtime?: ProfileRuntime;
  runtimeRetryAt: number;
}

function describe(err: unknown, credentials: string): { message: string; auth: boolean } {
  if (isAuthExpiredError(err)) {
    return { message: relogin(credentials), auth: true };
  }
  if (err instanceof NotionError && err.unauthorized) {
    return { message: RELLOGIN_NOTION(credentials), auth: true };
  }
  if (err instanceof SetupError) {
    return { message: err.message, auth: true };
  }
  if (isTransportError(err)) {
    return { message: `Network problem (${safeErrorMessage(err)}); retrying next cycle.`, auth: false };
  }
  return { message: safeErrorMessage(err), auth: false };
}

/**
 * Long-running LaunchAgent loop. Per enabled profile: ingest every pollSeconds
 * (deep scan every 10 min), Summary→Transcript sync every syncSeconds.
 * Re-reads config.json when it changes, so turning Tim on needs no restart.
 */
export async function runDaemon(options: {
  store: SecretStore;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<number> {
  const env = options.env || process.env;
  const log = options.log;
  const lock = createJobLock({ lockFile: getLockFilePath(env), log: (m) => log.warn(m) });
  if (!lock.acquire()) {
    log.warn("Another plaud-notes-to-notion daemon holds the lock; exiting.");
    return 0;
  }
  const stop = () => lock.release();
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });

  let config: AppConfig = loadConfig(env);
  let configMtime = fs.statSync(getConfigPath(env)).mtimeMs;
  const timers = new Map<string, ProfileTimers>();
  log.info(`Daemon started (poll ${config.pollSeconds}s, sync ${config.syncSeconds}s, model ${config.llmModel}/${config.llmEffort}).`);

  const reportError = (name: string, credentials: string, err: unknown) => {
    const { message, auth } = describe(err, credentials);
    const now = new Date();
    const prev = readStatus(env)[name];
    const patch: Record<string, string> = { lastError: message, lastErrorAt: now.toISOString() };
    if (auth && (!prev?.alertedAt || now.getTime() - Date.parse(prev.alertedAt) > ALERT_EVERY_MS)) {
      notifyMac("Plaud Notes to Notion", message);
      patch.alertedAt = now.toISOString();
    }
    updateStatus(name, patch, env);
    log.error(`[${name}] ${message}`);
    return auth;
  };

  while (!options.signal?.aborted) {
    try {
      const mtime = fs.statSync(getConfigPath(env)).mtimeMs;
      if (mtime !== configMtime) {
        config = loadConfig(env);
        configMtime = mtime;
        for (const t of timers.values()) {
          t.runtime = undefined;
        }
        log.info("Config changed; reloaded.");
      }
    } catch (err) {
      log.error(`Config reload failed; keeping previous config: ${safeErrorMessage(err)}`);
    }

    for (const [name, profile] of Object.entries(config.profiles)) {
      if (!profile.enabled || (!profile.ingest && !profile.syncTranscripts)) {
        continue;
      }
      const now = Date.now();
      const t = timers.get(name) || { nextPoll: now, nextSync: now, nextDeep: now, runtimeRetryAt: 0 };
      timers.set(name, t);
      if (!t.runtime) {
        if (now < t.runtimeRetryAt) {
          continue;
        }
        try {
          t.runtime = await buildProfileRuntime({
            name,
            profile,
            config,
            store: options.store,
            env,
            needPlaud: profile.ingest,
            needLabeler: profile.ingest
          });
        } catch (err) {
          reportError(name, profile.credentials, err);
          t.runtimeRetryAt = now + RUNTIME_RETRY_MS;
          continue;
        }
      }
      const rt = t.runtime;
      const state = loadState(name, env);
      const save = () => saveState(name, state, env);
      const plog = (m: string) => log.info(m);

      if (profile.ingest && now >= t.nextPoll) {
        const deep = now >= t.nextDeep;
        t.nextPoll = now + config.pollSeconds * 1000;
        if (deep) {
          t.nextDeep = now + DEEP_SCAN_EVERY_MS;
        }
        updateStatus(name, { lastPollAt: new Date().toISOString() }, env);
        try {
          const r = await runIngest(
            {
              profile: name,
              owner: profile.owner,
              startAfter: new Date(profile.startAfter),
              plaud: rt.plaud,
              notion: rt.notion,
              labeler: rt.labeler,
              state,
              save,
              log: plog
            },
            { deep }
          );
          pruneState(state, new Date());
          save();
          const patch: Record<string, unknown> = { lastPollOkAt: new Date().toISOString(), pending: r.pending };
          if (r.written.length) {
            patch.lastWritten = { title: r.written.at(-1)?.title, at: new Date().toISOString() };
          }
          if (!r.errors.length) {
            patch.lastError = undefined;
          } else {
            for (const e of r.errors) {
              log.error(`[${name}] ${e}`);
            }
          }
          updateStatus(name, patch, env);
        } catch (err) {
          if (reportError(name, profile.credentials, err)) {
            t.runtime = undefined;
            t.runtimeRetryAt = Date.now() + RUNTIME_RETRY_MS;
            continue;
          }
        }
      }

      if (profile.syncTranscripts && now >= t.nextSync) {
        t.nextSync = now + config.syncSeconds * 1000;
        try {
          await runSync({ profile: name, notion: rt.notion, state, save, log: plog });
          updateStatus(name, { lastSyncOkAt: new Date().toISOString() }, env);
        } catch (err) {
          if (reportError(name, profile.credentials, err)) {
            t.runtime = undefined;
            t.runtimeRetryAt = Date.now() + RUNTIME_RETRY_MS;
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  return 0;
}
