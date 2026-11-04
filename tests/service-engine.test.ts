import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { serviceModel, serviceSelection } from "../src/service-engine.js";
import { buildProfileRuntime } from "../src/runtime.js";
import { parseConfig } from "../src/config.js";
import { MemorySecretStore } from "../src/secrets.js";
import { solLabeler } from "../src/llm.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-policy-test-"));
  folders.push(root);
  const policy = path.join(root, "policy.json");
  const env = { ...process.env, TOOLBOX_SERVICE_ENGINE_FILE: policy, TOOLBOX_SERVICE_MODEL_BIN: path.join(root, "model.mjs") };
  const write = (engine: string, generation = engine) => fs.writeFileSync(policy, JSON.stringify({ version: 1, engine, generation, updated_at: "2026-11-03T12:00:00Z" }));
  const transport = (body: string) => fs.writeFileSync(env.TOOLBOX_SERVICE_MODEL_BIN, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  const shell = (body: string) => fs.writeFileSync(env.TOOLBOX_SERVICE_MODEL_BIN, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return { root, policy, env, write, transport, shell };
}
const request = { service: "fixture", system: "safe", prompt: "synthetic input", schema: { type: "object" }, timeoutMs: 1000 };

it("switches labeler on the next unit without API keys and retains an in-flight selection", async () => {
  const f = fixture();
  const store = new MemorySecretStore();
  await store.set("notion:p", "fixture");
  const config = parseConfig({ profiles: { p: { owner: "Alex Example", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } } });
  f.write("sol");
  f.transport(`let input="";process.stdin.on("data",data=>input+=data);process.stdin.on("end",()=>{const req=JSON.parse(input);if(req.service!=="plaud"||!req.prompt.includes("Alex Example"))process.exit(3);console.log(JSON.stringify({version:1,engine:"codex",model:"gpt-6.1-sol",text:JSON.stringify({participants:["Sam"]})}));});`);
  const options = { name: "p", profile: config.profiles.p, config, store, env: f.env, needPlaud: false, needLabeler: true };
  const selected = await buildProfileRuntime(options);
  f.write("claude");
  expect(await selected.labeler.label({ owner: "Alex Example", plaudTitle: "fixture", summaryMarkdown: "Sam speaks", transcriptText: "Sam: hello", knownParticipants: [] })).toEqual({ participants: ["Sam"] });
  await expect(buildProfileRuntime(options)).rejects.toThrow("set-secret anthropic");
});

it("refuses FIFO policy without blocking before descriptor validation", () => {
  const f = fixture();
  execFileSync("/usr/bin/mkfifo", [f.policy]);
  const module = new URL("../dist/service-engine.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {serviceSelection} from ${JSON.stringify(module)};try{serviceSelection();process.exitCode=2;}catch{process.stdout.write("rejected");}`],
  { env: f.env, encoding: "utf8", timeout: 1500 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("rejected");
});

it("rejects malformed Sol labels without coercing participants or keeping extra fields", async () => {
  const f = fixture();
  const labeler = solLabeler(f.env);
  for (const value of [null, { participants: [1] }, { participants: ["Sam"], unexpected: true }]) {
    f.transport(`console.log(JSON.stringify({version:1,engine:"codex",model:"gpt-6.1-sol",text:${JSON.stringify(JSON.stringify(value))}}));`);
    await expect(labeler.label({ owner: "Alex Example", plaudTitle: "Fixture", summaryMarkdown: "Synthetic only", transcriptText: "", knownParticipants: [] })).rejects.toMatchObject({ transient: false });
  }
});

describe("manual service engine policy", () => {
  it("uses the original baseline only for an absent policy", () => {
    const f = fixture();
    expect(serviceSelection(f.env)).toEqual({ engine: "claude", generation: "baseline" });
    f.write("sol");
    const selection = serviceSelection(f.env);
    f.write("claude");
    expect(selection.engine).toBe("sol");
    expect(Object.isFrozen(selection)).toBe(true);
    expect(serviceSelection(f.env).engine).toBe("claude");
  });
  it("fails closed on malformed, oversized, unsupported and symlink policy", () => {
    const f = fixture();
    for (const value of ["{", "null", " ".repeat(8193), JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, engine: "cursor" })]) {
      fs.writeFileSync(f.policy, value);
      expect(() => serviceSelection(f.env)).toThrow("policy is invalid");
    }
    fs.renameSync(f.policy, path.join(f.root, "target"));
    fs.symlinkSync(path.join(f.root, "target"), f.policy);
    expect(() => serviceSelection(f.env)).toThrow("policy is unreadable");
  });
  it("refuses invalid timestamps and empty generations", () => {
    const f = fixture();
    f.write("sol", "");
    expect(() => serviceSelection(f.env)).toThrow();
    fs.writeFileSync(f.policy, JSON.stringify({ version: 1, engine: "sol", generation: "one", updated_at: "not a date" }));
    expect(() => serviceSelection(f.env)).toThrow();
  });
});

describe("subscription transport", () => {
  it("pins codex and Sol, and preserves one already-selected request", async () => {
    const f = fixture();
    f.shell(`test "$1" = codex || exit 3\ncat > '${f.root}/input'\nprintf '%s' '{"version":1,"engine":"codex","model":"gpt-6.1-sol","text":"{\\"ok\\":true}"}'`);
    f.write("claude");
    expect(JSON.parse(await serviceModel(request, f.env))).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(f.root, "input"), "utf8"))).toMatchObject({ version: 1, service: "fixture" });
  });
  it("does not expose stderr or retry after a provider limit", async () => {
    const f = fixture();
    f.shell(`printf '%s' 'private provider data' >&2\nexit 2`);
    await expect(serviceModel(request, f.env)).rejects.toMatchObject({ message: "Codex subscription usage limit", usageLimit: true });
  });
  it("rejects foreign engines, models and malformed envelopes", async () => {
    const f = fixture();
    for (const reply of ["broken", JSON.stringify({ version: 1, engine: "cursor", model: "gpt-6.1-sol", text: "{}" }), JSON.stringify({ version: 1, engine: "codex", model: "other", text: "{}" })]) {
      f.shell(`printf '%s' '${reply}'`);
      await expect(serviceModel(request, f.env)).rejects.toThrow("Invalid service model response");
    }
  });
  it("bounds output and rejects an unavailable transport", async () => {
    const f = fixture();
    await expect(serviceModel(request, f.env)).rejects.toThrow("transport unavailable");
    f.transport(`process.stdout.write("x".repeat(3*1024*1024));`);
    await expect(serviceModel(request, f.env)).rejects.toThrow("exceeded bound");
  });
  it("enforces timeout even if a transport ignores TERM", async () => {
    const f = fixture();
    f.transport(`process.on("SIGTERM",()=>{});setInterval(()=>{},1000);`);
    await expect(serviceModel({ ...request, timeoutMs: 1 }, f.env)).rejects.toThrow("timed out");
  }, 6000);
  it("rejects invalid timeout and oversized input before spawning", async () => {
    const f = fixture();
    await expect(serviceModel({ ...request, timeoutMs: 600001 }, f.env)).rejects.toThrow("timeout");
    await expect(serviceModel({ ...request, prompt: "x".repeat(3 * 1024 * 1024) }, f.env)).rejects.toThrow("request exceeded bound");
  });
});
