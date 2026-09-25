import { execFileSync } from "node:child_process";
import { getProfile, loadConfig } from "./config.js";
import { notionAccount, OPENAI_ACCOUNT, openaiAccount, PACKAGE_NAME, PACKAGE_VERSION, plaudAccount } from "./constants.js";
import { runDaemon } from "./daemon.js";
import { runIngest } from "./ingest.js";
import { createLogger } from "./log.js";
import { getConfigPath, getLogFilePath } from "./paths.js";
import { runPlaudLogin } from "./plaud/login.js";
import { createAuthSession } from "./plaud/session.js";
import { safeErrorMessage } from "./redact.js";
import { buildProfileRuntime, openaiKey, readStatus } from "./runtime.js";
import { createSecretStore, type SecretStore } from "./secrets.js";
import { loadState, saveState } from "./state.js";
import { runSync } from "./sync.js";

const USAGE = `${PACKAGE_NAME} ${PACKAGE_VERSION}

Usage:
  ${PACKAGE_NAME} run                                  Daemon (LaunchAgent): ingest + sync for enabled profiles
  ${PACKAGE_NAME} once   --profile <p> [--dry-run] [--deep]   One ingest cycle
  ${PACKAGE_NAME} sync   --profile <p> [--dry-run] [--full]   One Summary→Transcript sync cycle
  ${PACKAGE_NAME} login  --profile <p> [--no-browser]  Plaud sign-in for that profile's Plaud account
  ${PACKAGE_NAME} logout --profile <p>
  ${PACKAGE_NAME} set-secret notion --profile <p> [--from-keychain <service>/<account>]
  ${PACKAGE_NAME} set-secret openai [--profile <p>] [--from-keychain <service>/<account>]
  ${PACKAGE_NAME} doctor --profile <p>                 Check sign-ins, Notion schema, OpenAI key
  ${PACKAGE_NAME} status                               Last poll/sync/write per profile

Config: ${getConfigPath()}
Log:    ${getLogFilePath()}`;

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function requireProfile(argv: string[]): string {
  const p = option(argv, "--profile");
  if (!p) {
    throw new Error("--profile <name> is required");
  }
  return p;
}

async function readSecretInput(argv: string[]): Promise<string> {
  const from = option(argv, "--from-keychain");
  if (from) {
    const [service, ...rest] = from.split("/");
    const account = rest.join("/");
    if (!service || !account) {
      throw new Error("--from-keychain expects <service>/<account>");
    }
    const value = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8"
    }).replace(/\n$/, "");
    if (!value) {
      throw new Error(`Keychain item ${from} is empty`);
    }
    return value;
  }
  if (process.stdin.isTTY) {
    process.stderr.write("Paste the secret and press Enter (input is hidden): ");
    execFileSync("/bin/stty", ["-echo"], { stdio: "inherit" });
  }
  try {
    const value = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => {
        buf += c;
        if (process.stdin.isTTY && buf.includes("\n")) {
          process.stdin.pause();
          resolve(buf);
        }
      });
      process.stdin.on("end", () => resolve(buf));
    });
    return value.trim();
  } finally {
    if (process.stdin.isTTY) {
      execFileSync("/bin/stty", ["echo"], { stdio: "inherit" });
      process.stderr.write("\n");
    }
  }
}

async function doctor(profileName: string, store: SecretStore): Promise<number> {
  const config = loadConfig();
  const profile = getProfile(config, profileName);
  const creds = profile.credentials;
  let ok = true;
  const line = (good: boolean, msg: string) => {
    ok &&= good;
    console.log(`${good ? "OK  " : "FAIL"} ${msg}`);
  };
  console.log(`Profile ${profileName}: ${profile.enabled ? "enabled" : "DISABLED"}, ingest ${profile.ingest}, sync ${profile.syncTranscripts}, owner ${profile.owner}, credentials ${creds}`);
  try {
    const rt = await buildProfileRuntime({ name: profileName, profile, config, store, needPlaud: false, needLabeler: false });
    const schema = await rt.notion.schema();
    line(true, `Notion data source ${profile.notionDataSourceId}: Type ${schema.typeKind}, Participants ${schema.participantsKind} (${schema.participantOptions.length} options)`);
  } catch (err) {
    line(false, `Notion: ${safeErrorMessage(err)}`);
  }
  if (profile.ingest) {
    try {
      const session = await createAuthSession({ store, account: plaudAccount(creds) });
      if (!session.peek()) {
        throw new Error(`not signed in — run: ${PACKAGE_NAME} login --profile ${creds}`);
      }
      const rt = await buildProfileRuntime({ name: profileName, profile, config, store, needPlaud: true, needLabeler: false });
      const files = await rt.plaud.listFiles(1, 10);
      line(true, `Plaud sign-in works (${files.length} recent files visible)`);
    } catch (err) {
      line(false, `Plaud: ${safeErrorMessage(err)}`);
    }
    try {
      await openaiKey(store, creds, process.env);
      line(true, `OpenAI key present (model ${config.llmModel}, effort ${config.llmEffort})`);
    } catch (err) {
      line(false, safeErrorMessage(err));
    }
  }
  return ok ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0];
  const store = createSecretStore();
  const verbose = flag(argv, "--verbose") || cmd !== "run";
  const log = createLogger({ verbose, stdout: (s) => process.stdout.write(`${s}\n`) });

  switch (cmd) {
    case "run":
      return runDaemon({ store, log });

    case "once": {
      const name = requireProfile(argv);
      const config = loadConfig();
      const profile = getProfile(config, name);
      const dryRun = flag(argv, "--dry-run");
      const rt = await buildProfileRuntime({ name, profile, config, store, needPlaud: true, needLabeler: true });
      const state = loadState(name);
      const r = await runIngest(
        {
          profile: name,
          owner: profile.owner,
          startAfter: new Date(option(argv, "--since") || profile.startAfter),
          plaud: rt.plaud,
          notion: rt.notion,
          labeler: rt.labeler,
          state,
          save: () => (dryRun ? undefined : saveState(name, state)),
          log: (m) => log.info(m),
          dryRun
        },
        { deep: flag(argv, "--deep") }
      );
      console.log(JSON.stringify(r, null, 2));
      return r.errors.length ? 1 : 0;
    }

    case "sync": {
      const name = requireProfile(argv);
      const config = loadConfig();
      const profile = getProfile(config, name);
      const rt = await buildProfileRuntime({ name, profile, config, store, needPlaud: false, needLabeler: false });
      const state = loadState(name);
      if (flag(argv, "--full")) {
        delete state.lastFullSyncAt;
      }
      const dryRun = flag(argv, "--dry-run");
      const r = await runSync({ profile: name, notion: rt.notion, state, save: () => saveState(name, state), log: (m) => log.info(m), dryRun });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }

    case "login": {
      const name = requireProfile(argv);
      return runPlaudLogin({ profile: name, store, account: plaudAccount(name), noBrowser: flag(argv, "--no-browser") });
    }

    case "logout": {
      const name = requireProfile(argv);
      await store.delete(plaudAccount(name));
      console.log(`Removed Plaud sign-in for profile ${name}.`);
      return 0;
    }

    case "set-secret": {
      const kind = argv[1];
      const profile = option(argv, "--profile");
      if (kind !== "notion" && kind !== "openai") {
        throw new Error("set-secret expects notion or openai");
      }
      if (kind === "notion" && !profile) {
        throw new Error("set-secret notion needs --profile <name>");
      }
      const value = await readSecretInput(argv);
      if (!value) {
        throw new Error("Empty secret; nothing saved.");
      }
      const account = kind === "notion" ? notionAccount(profile as string) : profile ? openaiAccount(profile) : OPENAI_ACCOUNT;
      await store.set(account, value);
      console.log(`Saved ${kind} secret to ${store.describe()} account ${account}.`);
      return 0;
    }

    case "doctor":
      return doctor(requireProfile(argv), store);

    case "status": {
      const status = readStatus();
      let config;
      try {
        config = loadConfig();
      } catch {
        config = null;
      }
      for (const [name, p] of Object.entries(config?.profiles || {})) {
        const s = status[name] || {};
        const state = loadState(name);
        const pending = Object.values(state.files).filter((f) => f.status === "pending");
        console.log(`${name}: ${p.enabled ? "ON" : "off"} (ingest ${p.ingest}, sync ${p.syncTranscripts})`);
        console.log(`  last poll ok:  ${s.lastPollOkAt || "never"}`);
        console.log(`  last sync ok:  ${s.lastSyncOkAt || "never"}`);
        console.log(`  last written:  ${s.lastWritten ? `${s.lastWritten.title} (${s.lastWritten.at})` : "none"}`);
        console.log(`  pending:       ${pending.length}${pending.length ? ` — ${pending.map((f) => f.name || "?").join("; ")}` : ""}`);
        if (s.lastError) {
          console.log(`  last error:    ${s.lastError} (${s.lastErrorAt})`);
        }
      }
      return 0;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    case "--version":
    case "version":
      console.log(PACKAGE_VERSION);
      return 0;

    default:
      console.error(USAGE);
      return 2;
  }
}
