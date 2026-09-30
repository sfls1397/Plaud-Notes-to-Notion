import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { AnthropicLabeler, createLabeler, LlmError, OpenAiLabeler } from "../src/llm.js";
import { redactSecrets } from "../src/redact.js";
import { buildProfileRuntime } from "../src/runtime.js";
import { MemorySecretStore } from "../src/secrets.js";

const INPUT = { owner: "Peter", plaudTitle: "t", summaryMarkdown: "s", transcriptText: "x", knownParticipants: [] };

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

describe("AnthropicLabeler", () => {
  it("forces the plaud_labels tool on the Messages API and returns its participants", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "Labeling." },
            { type: "tool_use", id: "toolu_1", name: "plaud_labels", input: { participants: ["Sam", 3, "Dana - Acme"] } }
          ]
        })
      );
    }) as unknown as typeof fetch;
    const labeler = new AnthropicLabeler({ apiKey: "k", baseUrl: "https://api.test/", model: "claude-haiku-4-5", fetchImpl });
    const out = await labeler.label(INPUT);
    expect(url).toBe("https://api.test/v1/messages");
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.tool_choice).toEqual({ type: "tool", name: "plaud_labels" });
    expect((body.tools as Array<{ name: string; input_schema: { required: string[] } }>)[0]).toMatchObject({
      name: "plaud_labels",
      input_schema: { required: ["participants"] }
    });
    expect((body.messages as Array<{ role: string }>)[0].role).toBe("user");
    expect(out.participants).toEqual(["Sam", "Dana - Acme"]);
  });

  it("treats 401 as permanent and 529 as transient", async () => {
    for (const [status, transient] of [
      [401, false],
      [529, true],
      [429, true]
    ] as const) {
      const fetchImpl = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      const labeler = new AnthropicLabeler({ apiKey: "k", baseUrl: "https://api.test", model: "claude-haiku-4-5", fetchImpl });
      const err = await labeler.label(INPUT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).transient).toBe(transient);
    }
  });

  it("fails transiently when no tool call comes back", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }))) as unknown as typeof fetch;
    const labeler = new AnthropicLabeler({ apiKey: "k", baseUrl: "https://api.test", model: "claude-haiku-4-5", fetchImpl });
    await expect(labeler.label(INPUT)).rejects.toMatchObject({ transient: true });
  });
});

describe("createLabeler", () => {
  const base = { effort: "high", openaiBaseUrl: "https://o.test/v1", anthropicBaseUrl: "https://a.test" };
  it("routes claude-* to Anthropic and anything else to OpenAI", () => {
    expect(createLabeler({ ...base, model: "claude-haiku-4-5", anthropicKey: "a" })).toBeInstanceOf(AnthropicLabeler);
    expect(createLabeler({ ...base, model: "gpt-6-luna", openaiKey: "o" })).toBeInstanceOf(OpenAiLabeler);
  });
  it("fails loud when the model's provider key is missing", () => {
    expect(() => createLabeler({ ...base, model: "claude-haiku-4-5", openaiKey: "o" })).toThrow(/Anthropic/);
    expect(() => createLabeler({ ...base, model: "gpt-6-luna", anthropicKey: "a" })).toThrow(/OpenAI/);
  });
});

describe("config LLM defaults", () => {
  it("defaults to Claude Haiku and keeps Luna one config field away", () => {
    const d = parseConfig({});
    expect(d.llmModel).toBe("claude-haiku-4-5");
    expect(d.anthropicBaseUrl).toBe("https://api.anthropic.com");
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
    profiles: { p: { owner: "Peter", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } }
  }).profiles.p;
  const build = async (llmModel: string, secrets: Record<string, string>) => {
    const store = new MemorySecretStore();
    await store.set("notion:p", "n");
    for (const [k, v] of Object.entries(secrets)) await store.set(k, v);
    const config = parseConfig({ llmModel });
    return buildProfileRuntime({ name: "p", profile, config, store, env: {}, needPlaud: false, needLabeler: true });
  };
  it("names set-secret anthropic when Haiku is configured and the key is missing", async () => {
    await expect(build("claude-haiku-4-5", { openai: "o" })).rejects.toThrow(/set-secret anthropic/);
    await expect(build("claude-haiku-4-5", { anthropic: "a" })).resolves.toBeDefined();
  });
  it("names set-secret openai when Luna is configured and the key is missing", async () => {
    await expect(build("gpt-6-luna", { anthropic: "a" })).rejects.toThrow(/set-secret openai/);
    await expect(build("gpt-6-luna", { openai: "o" })).resolves.toBeDefined();
  });
});
