import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ClaudeSubscriptionLabeler, createLabeler, LlmError, OpenAiLabeler } from "../src/llm.js";
import { redactSecrets } from "../src/redact.js";
import { buildProfileRuntime } from "../src/runtime.js";
import { MemorySecretStore } from "../src/secrets.js";

const INPUT = { owner: "Alex Example", plaudTitle: "t", summaryMarkdown: "s", transcriptText: "x", knownParticipants: [] };

describe("OpenAiLabeler", () => {
  it("asks OpenAI not to store the request (store: false) and returns participants", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ participants: ["Sam"] }) }));
    }) as unknown as typeof fetch;
    const labeler = new OpenAiLabeler({ apiKey: "k", baseUrl: "https://api.test/v1", model: "gpt-6-luna", effort: "high", fetchImpl });
    const out = await labeler.label(INPUT);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(out.participants).toEqual(["Sam"]);
  });
});

describe("createLabeler", () => {
  const base = { effort: "high", openaiBaseUrl: "https://o.test/v1" };
  it("routes claude-* to the Claude subscription (no key) and anything else to OpenAI", () => {
    expect(createLabeler({ ...base, model: "claude-haiku-5-5" })).toBeInstanceOf(ClaudeSubscriptionLabeler);
    expect(createLabeler({ ...base, model: "gpt-6-luna", openaiKey: "o" })).toBeInstanceOf(OpenAiLabeler);
  });
  it("fails loud when an OpenAI model has no OpenAI key", () => {
    expect(() => createLabeler({ ...base, model: "gpt-6-luna" })).toThrow(/OpenAI/);
  });
});

describe("config LLM defaults", () => {
  it("defaults to Claude Haiku and keeps Luna one config field away", () => {
    const d = parseConfig({});
    expect(d.llmModel).toBe("claude-haiku-5-5");
    expect(d).not.toHaveProperty("anthropicBaseUrl");
    // An older config file that still names an Anthropic endpoint loads, and the endpoint is ignored.
    expect(parseConfig({ anthropicBaseUrl: "https://api.anthropic.com" })).not.toHaveProperty("anthropicBaseUrl");
    expect(d.openaiBaseUrl).toBe("https://api.openai.com/v1");
    expect(parseConfig({ llmModel: "gpt-6-luna" }).llmModel).toBe("gpt-6-luna");
  });
});

describe("redaction", () => {
  it("hides Anthropic keys", () => {
    const out = redactSecrets("ANTHROPIC_API_KEY=abc123 and sk-ant-api03-ABCDEFGHIJKLMNOPqrstu");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sk-ant-api03");
  });
});

describe("buildProfileRuntime labeler key", () => {
  const profile = parseConfig({
    profiles: { p: { owner: "Alex Example", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } }
  }).profiles.p;
  const build = async (llmModel: string, secrets: Record<string, string>) => {
    const store = new MemorySecretStore();
    await store.set("notion:p", "n");
    for (const [k, v] of Object.entries(secrets)) await store.set(k, v);
    const config = parseConfig({ llmModel });
    return buildProfileRuntime({ name: "p", profile, config, store, env: {}, needPlaud: false, needLabeler: true });
  };
  it("Haiku needs no key at all: it runs on the Claude subscription", async () => {
    await expect(build("claude-haiku-5-5", {})).resolves.toBeDefined();
    const rt = await build("claude-haiku-5-5", { anthropic: "a" });
    expect(rt.labeler).toBeInstanceOf(ClaudeSubscriptionLabeler);
  });
  it("names set-secret openai when Luna is configured and the key is missing", async () => {
    await expect(build("gpt-6-luna", { anthropic: "a" })).rejects.toThrow(/set-secret openai/);
    await expect(build("gpt-6-luna", { openai: "o" })).resolves.toBeDefined();
  });
});
