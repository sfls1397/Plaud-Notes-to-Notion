import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeSubscriptionError,
  readReply,
  subscriptionArgs,
  subscriptionEnv
} from "../src/claude-subscription.js";
import { createLabeler } from "../src/llm.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAIKU = "claude-haiku-5-5";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("no model call can reach the Claude API", () => {
  it("src/ has no Anthropic API endpoint, header or key-reading model path", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(root, "src"))) {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file);
      for (const banned of ["api.anthropic.com", "x-api-key", "anthropic-version", "/v1/messages"]) {
        if (text.includes(banned)) offenders.push(`${rel}: ${banned}`);
      }
      // Only secrets.ts (the env-name map), redact.ts (scrubbing) and claude-subscription.ts (which strips it) may name it.
      if (!/(secrets|redact|claude-subscription)\.ts$/.test(rel) && /ANTHROPIC_API_KEY|anthropicKey|anthropicApiKey/.test(text)) {
        offenders.push(`${rel}: reads an Anthropic API key`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a Claude model needs no key and gets the subscription labeler", () => {
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", env: { HOME: "/nowhere" } });
    expect(labeler.constructor.name).toBe("ClaudeSubscriptionLabeler");
  });
});

describe("subscriptionEnv", () => {
  it("keeps only the allowlist, so no API credential or provider switch reaches Claude Code", () => {
    const env = subscriptionEnv({
      HOME: "/h",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "fixture-not-a-key",
      ANTHROPIC_AUTH_TOKEN: "fixture",
      ANTHROPIC_BASE_URL: "http://example.invalid",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "fixture",
      ANTHROPIC_API_KEY_PETER: "fixture"
    });
    expect(env).toEqual({ HOME: "/h", PATH: "/bin" });
  });
});

function stream(init: Record<string, unknown>, result: Record<string, unknown>): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none", model: HAIKU, ...init }),
    JSON.stringify({ type: "assistant", message: {} }),
    JSON.stringify({ type: "result", is_error: false, result: "", modelUsage: { [HAIKU]: {} }, ...result })
  ].join("\n");
}

describe("readReply", () => {
  it("returns the structured output, encoded", () => {
    expect(readReply(HAIKU, 0, stream({}, { structured_output: { participants: ["Dana"] } }), "")).toBe('{"participants":["Dana"]}');
  });

  it("refuses a run that used an API key", () => {
    expect(() => readReply(HAIKU, 0, stream({ apiKeySource: "ANTHROPIC_API_KEY" }, { structured_output: {} }), "")).toThrow(
      /not on the Claude subscription/
    );
    expect(() => readReply(HAIKU, 0, stream({ apiKeySource: undefined }, { structured_output: {} }), "")).toThrow(
      /not on the Claude subscription/
    );
  });

  it("refuses a non-Haiku model", () => {
    expect(() =>
      readReply(HAIKU, 0, stream({}, { structured_output: {}, modelUsage: { "claude-opus-5-5": {} } }), "")
    ).toThrow(/other than Haiku/);
    expect(() => readReply(HAIKU, 0, stream({ model: "claude-sonnet-5-5" }, { structured_output: {} }), "")).toThrow(
      /different model/
    );
  });

  it("maps a subscription usage limit to usageLimit", () => {
    let caught: unknown;
    try {
      readReply(HAIKU, 1, stream({}, { is_error: true, result: "You've hit your weekly limit · resets 9pm" }), "");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClaudeSubscriptionError);
    expect((caught as ClaudeSubscriptionError).usageLimit).toBe(true);
  });

  it("args skip every settings file and pin the model", () => {
    const args = subscriptionArgs({ model: HAIKU, system: "s", prompt: "p", schema: {} });
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", ""]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", HAIKU]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  });
});

describe("end to end through a fake Claude Code", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeClaude(reply: { apiKeySource?: string; participants?: string[]; limit?: boolean }): { bin: string; record: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaud-fake-claude-"));
    dirs.push(dir);
    const record = path.join(dir, "record.json");
    const bin = path.join(dir, "claude");
    const init = { type: "system", subtype: "init", apiKeySource: reply.apiKeySource ?? "none", model: HAIKU };
    const result = reply.limit
      ? { type: "result", is_error: true, result: "You've hit your weekly limit" }
      : { type: "result", is_error: false, result: "", structured_output: { participants: reply.participants ?? [] }, modelUsage: { [HAIKU]: {} } };
    fs.writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), envNames: Object.keys(process.env), stdinLength: stdin.length }));
  process.stdout.write(${JSON.stringify(JSON.stringify(init))} + "\\n" + ${JSON.stringify(JSON.stringify(result))} + "\\n");
  process.exit(${reply.limit ? 1 : 0});
});
`,
      { mode: 0o755 }
    );
    return { bin, record };
  }

  const input = { owner: "Peter", plaudTitle: "Call", summaryMarkdown: "Dana called.", transcriptText: "Dana: hi", knownParticipants: ["Dana - Acme"] };

  it("labels on the subscription; the parent's API key never reaches Claude Code", async () => {
    const fake = fakeClaude({ participants: ["Dana - Acme"] });
    const env = { HOME: os.homedir(), PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "fixture-not-a-key", CLAUDE_SUBSCRIPTION_BIN: fake.bin };
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", env });
    await expect(labeler.label(input)).resolves.toEqual({ participants: ["Dana - Acme"] });
    const seen = JSON.parse(fs.readFileSync(fake.record, "utf8")) as { args: string[]; envNames: string[]; stdinLength: number };
    expect(seen.envNames).not.toContain("ANTHROPIC_API_KEY");
    expect(seen.envNames).not.toContain("CLAUDE_SUBSCRIPTION_BIN");
    expect(seen.args).toContain("--setting-sources");
    expect(seen.args[seen.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(seen.args[seen.args.indexOf("--model") + 1]).toBe(HAIKU);
    expect(seen.stdinLength).toBeGreaterThan(0);
  });

  it("refuses a reply from a run that used an API key", async () => {
    const fake = fakeClaude({ apiKeySource: "ANTHROPIC_API_KEY", participants: ["Dana"] });
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", transient: false });
  });

  it("a subscription usage limit is a usage-limit LlmError", async () => {
    const fake = fakeClaude({ limit: true });
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", transient: true, usageLimit: true });
  });
});
