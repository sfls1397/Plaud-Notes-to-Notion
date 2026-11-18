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
import { CLAUDE_API_HOLD_MS, ClaudeLabeler, createLabeler, resetClaudeApiHold } from "../src/llm.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAIKU = "claude-haiku-5-5";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("the subscription transport", () => {
  it("never names the Anthropic API or reads a key", () => {
    const text = fs.readFileSync(path.join(root, "src", "claude-subscription.ts"), "utf8");
    expect(text).not.toMatch(/api\.anthropic\.com|x-api-key|anthropic-version|\/v1\/messages|env\.ANTHROPIC_API_KEY|fetch\(/);
  });

  it("a Claude model gets the subscription-first labeler, with or without a key", () => {
    for (const anthropicKey of [undefined, "fixture-not-a-key"]) {
      const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://example.invalid", anthropicKey, env: { HOME: "/nowhere" } });
      expect(labeler.constructor.name).toBe("ClaudeLabeler");
    }
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
    const account = os.userInfo().username;
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", USER: account, LOGNAME: account });
    expect(subscriptionEnv({ USER: "fixture-user", LOGNAME: "fixture-user" })).toEqual({ USER: "fixture-user", LOGNAME: "fixture-user" });
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

  function fakeClaude(reply: { apiKeySource?: string; participants?: string[]; limit?: boolean | string }): { bin: string; record: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaud-fake-claude-"));
    dirs.push(dir);
    const record = path.join(dir, "record.json");
    const bin = path.join(dir, "claude");
    const init = { type: "system", subtype: "init", apiKeySource: reply.apiKeySource ?? "none", model: HAIKU };
    const result = reply.limit
      ? { type: "result", is_error: true, result: typeof reply.limit === "string" ? reply.limit : "You've hit your weekly limit" }
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
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com", env });
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
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com", env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", transient: false });
  });

  it("a subscription usage limit is a usage-limit LlmError", async () => {
    const fake = fakeClaude({ limit: true });
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com", env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", transient: true, usageLimit: true });
  });

  // Peter, 11:58 PM CT Nov 17 2026: services outside T3 use the Claude subscription first and the Claude API only
  // while the subscription is at its usage limit, then go back to it.
  function apiStub() {
    const seen: Array<{ url: string; model: string; key: boolean }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ url: String(url), model: JSON.parse(String(init?.body)).model, key: Boolean(headers["x-api-key"]) });
      return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "plaud_labels", input: { participants: ["From The API"] } }] }));
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it("never calls the Claude API while the subscription answers, even with an Anthropic key", async () => {
    const fake = fakeClaude({ participants: ["Dana - Acme"] });
    const api = apiStub();
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com",
      anthropicKey: "fixture-not-a-key", fetchImpl: api.fetchImpl, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).resolves.toEqual({ participants: ["Dana - Acme"] });
    await expect(labeler.label(input)).resolves.toEqual({ participants: ["Dana - Acme"] });
    expect(api.seen).toEqual([]);
  });

  it("on the subscription's limit labels go to the Claude API with the same model for 15 minutes, then the subscription again", async () => {
    resetClaudeApiHold();
    const limited = fakeClaude({ limit: true });
    const api = apiStub();
    let clock = 5_000_000;
    const env = { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: limited.bin };
    const labeler = new ClaudeLabeler({ model: HAIKU, env, apiKey: "fixture-not-a-key", apiBaseUrl: "https://api.anthropic.com", fetchImpl: api.fetchImpl, now: () => clock, log: () => {} });
    try {
      await expect(labeler.label(input)).resolves.toEqual({ participants: ["From The API"] });
      expect(api.seen).toEqual([{ url: "https://api.anthropic.com/v1/messages", model: HAIKU, key: true }]);
      fs.rmSync(limited.record);
      clock += CLAUDE_API_HOLD_MS - 1;
      await expect(labeler.label(input)).resolves.toEqual({ participants: ["From The API"] });
      expect(fs.existsSync(limited.record)).toBe(false);
      const back = fakeClaude({ participants: ["Dana - Acme"] });
      env.CLAUDE_SUBSCRIPTION_BIN = back.bin;
      clock += 2;
      await expect(labeler.label(input)).resolves.toEqual({ participants: ["Dana - Acme"] });
      expect(api.seen.length).toBe(2);
    } finally {
      resetClaudeApiHold();
    }
  });

  it("a server throttle or bare 429 is a plain failure and a session limit only waits: neither falls back to the Claude API", async () => {
    const api = apiStub();
    for (const [words, expected] of [
      ["API Error: 429 Server is temporarily limiting requests (not your usage limit)", { usageLimit: false, planLimit: false }],
      ["API Error: 429 rate_limit_error too many requests", { usageLimit: false, planLimit: false }],
      ["Session limit reached ∙ resets 3am", { usageLimit: true, planLimit: false }],
      ["5-hour limit reached ∙ resets 3am", { usageLimit: true, planLimit: false }]
    ] as const) {
      const fake = fakeClaude({ limit: words });
      const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com",
        anthropicKey: "fixture-not-a-key", fetchImpl: api.fetchImpl, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
      await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", ...expected });
    }
    expect(api.seen).toEqual([]);
  });

  it("a non-limit subscription failure with a key present never falls back to the Claude API", async () => {
    const fake = fakeClaude({ limit: "Not logged in · Please run /login" });
    const api = apiStub();
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com",
      anthropicKey: "fixture-not-a-key", fetchImpl: api.fetchImpl, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", usageLimit: false });
    expect(api.seen).toEqual([]);
  });

  it("a refused subscription run is not a limit, so it never falls back to the Claude API", async () => {
    const fake = fakeClaude({ apiKeySource: "ANTHROPIC_API_KEY", participants: ["Dana"] });
    const api = apiStub();
    const labeler = createLabeler({ model: HAIKU, effort: "high", openaiBaseUrl: "https://example.invalid", anthropicBaseUrl: "https://api.anthropic.com",
      anthropicKey: "fixture-not-a-key", fetchImpl: api.fetchImpl, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CLAUDE_SUBSCRIPTION_BIN: fake.bin } });
    await expect(labeler.label(input)).rejects.toMatchObject({ name: "LlmError", transient: false });
    expect(api.seen).toEqual([]);
  });
});
