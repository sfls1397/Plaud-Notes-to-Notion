import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, saveConfig } from "../src/config.js";
import { MemorySecretStore } from "../src/secrets.js";
import { serviceSelection } from "../src/service-engine.js";

const mocks = vi.hoisted(() => ({ build: vi.fn(), ingest: vi.fn() }));
vi.mock("../src/runtime.js", async (original) => ({ ...await original<object>(), buildProfileRuntime: mocks.build }));
vi.mock("../src/ingest.js", () => ({ runIngest: mocks.ingest }));
import { runDaemon } from "../src/daemon.js";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("retains an active ingestion and changes cached engines only at the next unit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plaud-daemon-engine-"));
  const env = { ...process.env, PLAUD_NOTES_HOME: root, TOOLBOX_SERVICE_ENGINE_FILE: path.join(root, "engine.json") };
  const write = (engine: string) => fs.writeFileSync(env.TOOLBOX_SERVICE_ENGINE_FILE, JSON.stringify({ version: 1, engine, generation: engine, updated_at: new Date().toISOString() }));
  const previousTerm = new Set(process.listeners("SIGTERM"));
  const previousInt = new Set(process.listeners("SIGINT"));
  const controller = new AbortController();
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const selections: string[] = [];
  const used: string[] = [];
  vi.useFakeTimers();
  try {
    saveConfig(parseConfig({ pollSeconds: 10, profiles: { fixture: { enabled: true, ingest: true, syncTranscripts: false,
      owner: "Alex Example", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } } }), env);
    write("claude");
    mocks.build.mockImplementation(async (options) => {
      selections.push(options.selection.engine);
      return { labeler: { engine: options.selection.engine } };
    });
    mocks.ingest.mockImplementation(async (options) => {
      used.push(options.labeler.engine);
      if (used.length === 1) {
        write("sol");
        await active;
        expect(options.labeler.engine).toBe("claude");
      } else controller.abort();
      return { pending: 0, written: [], errors: [] };
    });
    const running = runDaemon({ store: new MemorySecretStore(), env, signal: controller.signal,
      log: { info: () => {}, warn: () => {}, error: () => {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(selections).toEqual(["claude"]);
    expect(serviceSelection(env).engine).toBe("sol");
    release();
    await vi.advanceTimersByTimeAsync(11000);
    expect(await running).toBe(0);
    expect(selections).toEqual(["claude", "sol"]);
    expect(used).toEqual(["claude", "sol"]);
  } finally {
    controller.abort();
    for (const listener of process.listeners("SIGTERM")) if (!previousTerm.has(listener)) process.removeListener("SIGTERM", listener);
    for (const listener of process.listeners("SIGINT")) if (!previousInt.has(listener)) process.removeListener("SIGINT", listener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
