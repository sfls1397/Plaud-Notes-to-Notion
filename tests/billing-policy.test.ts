import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { ClaudeLabeler } from "../src/llm.js";
import { buildProfileRuntime } from "../src/runtime.js";
import { MemorySecretStore } from "../src/secrets.js";
import { labelerSelection } from "../src/service-engine.js";

const HOLD = "hold: Claude billing pending included-usage-only route";
const INPUT = { owner: "Alex Example", plaudTitle: "t", summaryMarkdown: "s", transcriptText: "x", knownParticipants: [] };
const folders: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function home(marker?: string, mode = 0o600) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plaud-billing-"));
  folders.push(root);
  fs.mkdirSync(path.join(root, ".toolbox"));
  const file = path.join(root, ".toolbox", "claude-service-billing-plaud");
  if (marker !== undefined) {
    fs.writeFileSync(file, marker, { mode });
    fs.chmodSync(file, mode);
  }
  return { root, file, env: { HOME: root } as NodeJS.ProcessEnv };
}

function fakeClaude(root: string, limit: boolean) {
  const bin = path.join(root, "claude");
  const resolver = path.join(root, "model-versions");
  const record = path.join(root, "claude.log");
  fs.writeFileSync(resolver, `#!/bin/sh\necho claude-haiku-9-1\n`, { mode: 0o700 });
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const model = process.argv[process.argv.indexOf("--model") + 1];
  fs.appendFileSync(${JSON.stringify(record)}, model + "\\n");
  const init = { type: "system", subtype: "init", apiKeySource: "none", model };
  const result = ${limit}
    ? { type: "result", is_error: true, result: "You've hit your weekly limit" }
    : { type: "result", is_error: false, result: "", structured_output: { participants: ["Dana"] }, modelUsage: { [model]: {} } };
  process.stdout.write(JSON.stringify(init) + "\\n" + JSON.stringify(result) + "\\n");
  process.exit(${limit ? 1 : 0});
});
`, { mode: 0o755 });
  return { env: { CLAUDE_SUBSCRIPTION_BIN: bin, TOOLBOX_MODEL_VERSIONS_BIN: resolver } as NodeJS.ProcessEnv,
    ran: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter(Boolean) : []) };
}

async function runtimeFor(env: NodeJS.ProcessEnv, secrets: Record<string, string>) {
  const store = new MemorySecretStore();
  await store.set("notion:p", "n");
  for (const [name, value] of Object.entries(secrets)) await store.set(name, value);
  const config = parseConfig({ profiles: { p: { owner: "Alex Example", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } } });
  return buildProfileRuntime({ name: "p", profile: config.profiles.p, config, store, env, needPlaud: false, needLabeler: true });
}

describe("the Plaud Claude billing setting", () => {
  it("reads no file as the default route and the exact markers as api and subscription-only", () => {
    expect(labelerSelection("haiku", home().env)).toMatchObject({ engine: "claude" });
    expect(labelerSelection("haiku", home().env).claudeApi).toBeUndefined();
    expect(labelerSelection("haiku", home("claude-api\n").env).claudeApi).toBe(true);
    const only = labelerSelection("haiku", home("claude-subscription-only\n").env);
    expect(only.subscriptionOnly).toBe(true);
    expect(only.claudeApi).toBeUndefined();
  });

  it("still refuses the Nov 23 hold line: a hold is not permission to run", () => {
    expect(Buffer.byteLength(`${HOLD}\n`)).toBe(55);
    expect(() => labelerSelection("haiku", home(`${HOLD}\n`).env)).toThrow(/billing policy is invalid/);
    expect(() => labelerSelection("haiku", home(HOLD).env)).toThrow(/billing policy is invalid/);
  });

  it("refuses a loose file mode, other text, a missing newline, extra bytes and a link", () => {
    expect(() => labelerSelection("haiku", home("claude-subscription-only\n", 0o644).env)).toThrow(/invalid/);
    expect(() => labelerSelection("haiku", home("claude-subscription-only").env)).toThrow(/invalid/);
    expect(() => labelerSelection("haiku", home("claude-subscription-only\nclaude-api\n").env)).toThrow(/invalid/);
    expect(() => labelerSelection("haiku", home("claude-subscription-onlx\n").env)).toThrow(/invalid/);
    const linked = home();
    fs.writeFileSync(path.join(linked.root, "elsewhere"), "claude-subscription-only\n", { mode: 0o600 });
    fs.symlinkSync(path.join(linked.root, "elsewhere"), linked.file);
    expect(() => labelerSelection("haiku", linked.env)).toThrow(/unreadable/);
  });

  it("labels on the subscription with the newest Haiku and never builds the API route under the subscription-only setting, even with an Anthropic key", async () => {
    const h = home("claude-subscription-only\n");
    const claude = fakeClaude(h.root, false);
    const fetchSpy = vi.fn(async () => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = await runtimeFor({ ...h.env, ...claude.env }, { anthropic: "fixture-not-a-key" });
    expect(runtime.labeler).toBeInstanceOf(ClaudeLabeler);
    await expect(runtime.labeler.label(INPUT)).resolves.toEqual({ participants: ["Dana"] });
    expect(claude.ran()).toEqual(["claude-haiku-9-1"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a subscription usage limit under the subscription-only setting waits as a limit and never reaches the Claude API", async () => {
    const h = home("claude-subscription-only\n");
    const claude = fakeClaude(h.root, true);
    const fetchSpy = vi.fn(async () => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = await runtimeFor({ ...h.env, ...claude.env }, { anthropic: "fixture-not-a-key" });
    await expect(runtime.labeler.label(INPUT)).rejects.toMatchObject({ name: "LlmError", usageLimit: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("under the hold line the runtime refuses to build, so no label and no spend", async () => {
    const h = home(`${HOLD}\n`);
    const claude = fakeClaude(h.root, false);
    await expect(runtimeFor({ ...h.env, ...claude.env }, { anthropic: "fixture-not-a-key" })).rejects.toThrow(/billing policy is invalid/);
    expect(claude.ran()).toEqual([]);
  });
});
