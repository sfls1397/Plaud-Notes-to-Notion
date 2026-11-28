import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseConfig } from "../src/config.js";
import { DEFAULT_LLM_MODEL, isAnthropicModel } from "../src/constants.js";
import { AnthropicLabeler, ClaudeLabeler, createLabeler, resetClaudeApiHold } from "../src/llm.js";
import { describeModel, ModelResolveError, resolveModel } from "../src/model-version.js";
import { runIngest } from "../src/ingest.js";
import { buildProfileRuntime } from "../src/runtime.js";
import { MemorySecretStore } from "../src/secrets.js";
import { serviceModel } from "../src/service-engine.js";
import { emptyState } from "../src/state.js";
import { FakeNotion, FakePlaud } from "./fakes.js";

const INPUT = { owner: "Alex Example", plaudTitle: "t", summaryMarkdown: "s", transcriptText: "x", knownParticipants: [] };
const folders: string[] = [];
afterEach(() => {
  resetClaudeApiHold();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  folders.push(dir);
  return dir;
}

function resolver(body: string) {
  const root = scratch("model-version-test-");
  const bin = path.join(root, "model-versions");
  const log = path.join(root, "calls.log");
  const write = (script: string) => fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\n${script}\n`, { mode: 0o700 });
  write(body);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { bin, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", TOOLBOX_MODEL_VERSIONS_BIN: bin } as NodeJS.ProcessEnv, write, calls };
}

function fakeClaude(env: NodeJS.ProcessEnv, limit = false) {
  const dir = scratch("plaud-fake-claude-");
  const record = path.join(dir, "record.log");
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
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
  const ran = () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter(Boolean) : []);
  return { env: { ...env, CLAUDE_SUBSCRIPTION_BIN: bin }, ran };
}

function apiStub() {
  const models: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    models.push(JSON.parse(String(init?.body)).model);
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "plaud_labels", input: { participants: ["From The API"] } }] }));
  }) as unknown as typeof fetch;
  return { models, fetchImpl };
}

const labelerFor = (model: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, anthropicKey?: string) =>
  createLabeler({ model, effort: "high", anthropicKey, openaiBaseUrl: "https://o.test/v1", anthropicBaseUrl: "https://a.test", fetchImpl, env });

describe("the resolver call", () => {
  it("names the route and family and never a version", async () => {
    const r = resolver("echo claude-haiku-9-9");
    await expect(resolveModel("claude-api", "haiku", r.env)).resolves.toBe("claude-haiku-9-9");
    expect(r.calls()).toEqual(["resolve claude-api haiku"]);
  });

  it("retries once and then names the route, family and reason", async () => {
    const r = resolver("echo 'catalog missing' >&2; exit 2");
    const error = await resolveModel("claude", "haiku", r.env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelResolveError);
    expect((error as Error).message).toMatch(/claude.*haiku.*catalog missing/);
    expect(r.calls()).toEqual(["resolve claude haiku", "resolve claude haiku"]);
  });

  it("fails when the resolver is not installed", async () => {
    const env = { ...resolver("exit 0").env, TOOLBOX_MODEL_VERSIONS_BIN: "/nonexistent/model-versions" };
    await expect(resolveModel("claude-api", "haiku", env)).rejects.toThrow(/claude-api.*haiku.*not runnable/);
  });

  it("times out instead of hanging", async () => {
    const r = resolver("sleep 5; echo claude-haiku-9-9");
    const started = Date.now();
    await expect(resolveModel("claude-api", "haiku", r.env, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.calls()).toHaveLength(2);
  });

  it("refuses an answer from another family and an unusable answer instead of passing it on", async () => {
    for (const out of ["claude-sonnet-9-9", "", "claude-haiku-9-9 extra words", "gpt-9-luna"]) {
      const r = resolver(`echo '${out}'`);
      await expect(resolveModel("claude-api", "haiku", r.env)).rejects.toBeInstanceOf(ModelResolveError);
    }
  });

  it("gives the resolver only its allowlisted environment, never an API key or token", async () => {
    const r = resolver('env | grep -E "API_KEY|TOKEN|OAUTH" >&2 && exit 4; echo claude-haiku-9-9');
    const env = { ...r.env, ANTHROPIC_API_KEY: "fixture-a", OPENAI_API_KEY: "fixture-b", ANTHROPIC_AUTH_TOKEN: "fixture-c", CLAUDE_CODE_OAUTH_TOKEN: "fixture-d", NOTION_TOKEN: "fixture-e" };
    await expect(resolveModel("claude-api", "haiku", env)).resolves.toBe("claude-haiku-9-9");
  });

  it("shows what a family word resolves to and leaves an explicit id as written", async () => {
    const r = resolver("echo claude-haiku-9-9");
    await expect(describeModel("claude", "haiku", r.env)).resolves.toBe("haiku -> claude-haiku-9-9");
    await expect(describeModel("claude", "claude-haiku-4-5", r.env)).resolves.toBe("claude-haiku-4-5");
  });
});

describe("the subscription route (claude)", () => {
  const room = (script: string, limit = false) => {
    const r = resolver(script);
    const c = fakeClaude(r.env, limit);
    return { r, c, labeler: labelerFor("haiku", c.env) };
  };

  it("runs the newest Haiku the resolver names, again for every recording, with no restart", async () => {
    const { r, c, labeler } = room("echo claude-haiku-9-1");
    await labeler.label(INPUT);
    r.write("echo claude-haiku-9-2");
    await labeler.label(INPUT);
    expect(c.ran()).toEqual(["claude-haiku-9-1", "claude-haiku-9-2"]);
    expect(r.calls()).toEqual(["resolve claude haiku", "resolve claude haiku"]);
  });

  it("fails visibly and never starts Claude Code or the API when the family cannot be resolved", async () => {
    const r = resolver("echo 'no haiku in catalog' >&2; exit 2");
    const c = fakeClaude(r.env);
    const api = apiStub();
    const labeler = labelerFor("haiku", c.env, api.fetchImpl, "fixture-not-a-key");
    await expect(labeler.label(INPUT)).rejects.toThrow(/claude.*haiku.*no haiku in catalog/);
    expect(c.ran()).toEqual([]);
    expect(api.models).toEqual([]);
  });

  it("keeps an explicitly named model and never asks the resolver", async () => {
    const r = resolver("echo claude-haiku-9-9");
    const c = fakeClaude(r.env);
    await labelerFor("claude-haiku-4-5", c.env).label(INPUT);
    expect(c.ran()).toEqual(["claude-haiku-4-5"]);
    expect(r.calls()).toEqual([]);
  });
});

describe("the Claude API route (claude-api)", () => {
  it("sends the newest Haiku the resolver names for claude-api, for every recording", async () => {
    const r = resolver("echo claude-haiku-9-1");
    const api = apiStub();
    const labeler = new AnthropicLabeler({ apiKey: "k", baseUrl: "https://a.test", model: "haiku", env: r.env, fetchImpl: api.fetchImpl });
    await labeler.label(INPUT);
    r.write("echo claude-haiku-9-2");
    await labeler.label(INPUT);
    expect(api.models).toEqual(["claude-haiku-9-1", "claude-haiku-9-2"]);
    expect(r.calls()).toEqual(["resolve claude-api haiku", "resolve claude-api haiku"]);
  });

  it("fails visibly with no request sent when the family cannot be resolved", async () => {
    const r = resolver("echo 'no haiku in catalog' >&2; exit 2");
    const api = apiStub();
    const labeler = new AnthropicLabeler({ apiKey: "k", baseUrl: "https://a.test", model: "haiku", env: r.env, fetchImpl: api.fetchImpl });
    await expect(labeler.label(INPUT)).rejects.toThrow(/claude-api.*haiku.*no haiku in catalog/);
    expect(api.models).toEqual([]);
  });

  it("keeps an explicitly named model and never asks the resolver", async () => {
    const r = resolver("echo claude-haiku-9-9");
    const api = apiStub();
    await new AnthropicLabeler({ apiKey: "k", baseUrl: "https://a.test", model: "claude-haiku-4-5", env: r.env, fetchImpl: api.fetchImpl }).label(INPUT);
    expect(api.models).toEqual(["claude-haiku-4-5"]);
    expect(r.calls()).toEqual([]);
  });

  it("each route takes the newest on its own catalog when the subscription is at its usage limit", async () => {
    const r = resolver('case "$2" in claude) echo claude-haiku-9-1;; claude-api) echo claude-haiku-9-3;; esac');
    const c = fakeClaude(r.env, true);
    const api = apiStub();
    const labeler = new ClaudeLabeler({ model: "haiku", env: c.env, apiKey: "k", apiBaseUrl: "https://a.test", fetchImpl: api.fetchImpl, log: () => {} });
    await expect(labeler.label(INPUT)).resolves.toEqual({ participants: ["From The API"] });
    expect(c.ran()).toEqual(["claude-haiku-9-1"]);
    expect(api.models).toEqual(["claude-haiku-9-3"]);
  });

  it("never moves to the API when the subscription route cannot be resolved", async () => {
    const r = resolver('case "$2" in claude) echo "no claude catalog" >&2; exit 2;; claude-api) echo claude-haiku-9-3;; esac');
    const c = fakeClaude(r.env);
    const api = apiStub();
    const labeler = new ClaudeLabeler({ model: "haiku", env: c.env, apiKey: "k", apiBaseUrl: "https://a.test", fetchImpl: api.fetchImpl, log: () => {} });
    await expect(labeler.label(INPUT)).rejects.toThrow(/route claude, family haiku.*no claude catalog/);
    expect(api.models).toEqual([]);
  });
});

describe("ingest", () => {
  it("stops and keeps the recording pending instead of writing unlabeled rows when the family cannot be resolved", async () => {
    const r = resolver("echo 'catalog missing' >&2; exit 2");
    const c = fakeClaude(r.env);
    const plaud = new FakePlaud();
    plaud.add({ id: "synthetic" });
    const notion = new FakeNotion();
    const deps = { profile: "fixture", owner: "Alex Example", startAfter: new Date("2026-09-26T00:00:00Z"),
      plaud, notion, state: emptyState(), labeler: labelerFor("haiku", c.env), save: () => {}, log: () => {} };
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await runIngest(deps);
      expect(result.written).toEqual([]);
      expect(result.errors.join("\n")).toMatch(/route claude, family haiku.*catalog missing/);
    }
    expect(notion.rows).toHaveLength(0);
    expect(Object.values(deps.state.files).every((f) => f.llmAttempts === 0)).toBe(true);
  });
});

describe("configuration", () => {
  it("defaults to the Haiku family word and keeps an explicit id as written", () => {
    expect(DEFAULT_LLM_MODEL).toBe("haiku");
    expect(parseConfig({}).llmModel).toBe("haiku");
    expect(parseConfig({ llmModel: "claude-haiku-4-5" }).llmModel).toBe("claude-haiku-4-5");
  });

  it("treats the Claude family words as Claude models whatever their case, and no other word", () => {
    for (const word of ["haiku", "Sonnet", "OPUS"]) expect(isAnthropicModel(word)).toBe(true);
    for (const word of ["gpt-6-luna", "haikus", "fable"]) expect(isAnthropicModel(word)).toBe(false);
  });

  it("builds a runtime for the family word without resolving it up front", async () => {
    const r = resolver("exit 2");
    const c = fakeClaude(r.env);
    const store = new MemorySecretStore();
    await store.set("notion:p", "n");
    const profile = parseConfig({ profiles: { p: { owner: "Alex Example", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } } }).profiles.p;
    await expect(buildProfileRuntime({ name: "p", profile, config: parseConfig({}), store, env: { ...c.env, HOME: scratch("plaud-home-") }, needPlaud: false, needLabeler: true })).resolves.toBeDefined();
    expect(r.calls()).toEqual([]);
  });
});

describe("dormant Codex service engine", () => {
  const run = (model: string) => {
    const root = scratch("model-version-engine-");
    const bin = path.join(root, "model.mjs");
    fs.writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(JSON.stringify({version:1,engine:"codex",model:${JSON.stringify(model)},text:"ok"}));\n`, { mode: 0o700 });
    return serviceModel({ service: "fixture", system: "s", prompt: "p", schema: {}, timeoutMs: 5000 }, { ...process.env, TOOLBOX_SERVICE_MODEL_BIN: bin });
  };

  it("accepts any release of the Sol family the transport reports", async () => {
    await expect(run("gpt-6.1-sol")).resolves.toBe("ok");
    await expect(run("gpt-7-sol")).resolves.toBe("ok");
  });

  it("still rejects another family", async () => {
    await expect(run("gpt-6-luna")).rejects.toThrow(/Invalid service model response/);
    await expect(run("claude-haiku-5-5")).rejects.toThrow(/Invalid service model response/);
  });
});

describe("source has no hard-coded production model version (the rule of Toolbox lib/model_ledger.py)", () => {
  const LITERAL = new RegExp(
    String.raw`claude-(?:opus|sonnet|haiku|fable)-\d|gpt-\d[\d.]*-(?:sol|terra|luna|astra)\b|\bgrok-\d|text-embedding-|gemini-\d|` +
    String.raw`\bo[1-9]-(?:mini|pro)\b|nomic-embed|voyage-\d|bge-(?:small|base|large|m3)`);
  const SKIP_DIRS = ["tests/", "docs/", "rules/", "roster/", "skills/", "instructions/", "node_modules/", ".git/"];
  const SKIP_SUFFIXES = [".md", ".png", ".jpg", ".svg", ".pdf", ".lock", ".woff2"];
  const PIN = /model-pin:\s*\S/;

  function scanText(name: string, text: string): Array<[string, number, string]> {
    if (SKIP_DIRS.some((d) => name.startsWith(d)) || name.includes("/fixtures/") || SKIP_SUFFIXES.some((s) => name.endsWith(s))
        || /\.test\.[a-z]+$|_test\.[a-z]+$/.test(name)) return [];
    const lines = text.split("\n");
    const found: Array<[string, number, string]> = [];
    lines.forEach((line, index) => {
      const match = LITERAL.exec(line);
      if (match && !PIN.test(line) && !(index > 0 && PIN.test(lines[index - 1]))) found.push([name, index + 1, match[0]]);
    });
    return found;
  }

  it("catches a literal, and lets a model-pin line, a test and prose through", () => {
    for (const text of ['const m = "claude-haiku-5-5";', 'const m = "gpt-6.1-sol";', 'const m = "grok-5";', 'const m = "text-embedding-3-small";']) {
      expect(scanText("src/a.ts", text)).toHaveLength(1);
    }
    expect(scanText("src/a.ts", 'const m = "claude-haiku-5-5"; // model-pin: benchmark')).toEqual([]);
    expect(scanText("src/a.ts", '// model-pin: benchmark\nconst m = "claude-haiku-5-5";')).toEqual([]);
    expect(scanText("tests/a.test.ts", 'const m = "claude-haiku-5-5";')).toEqual([]);
    expect(scanText("README.md", "claude-haiku-5-5")).toEqual([]);
  });

  it("finds none in this repository's production files", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const found = files.flatMap((name) => {
      try { return scanText(name, fs.readFileSync(path.join(root, name), "utf8")); } catch { return []; }
    });
    expect(found).toEqual([]);
  });
});
