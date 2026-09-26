import { describe, expect, it } from "vitest";
import { OpenAiLabeler } from "../src/llm.js";

describe("OpenAiLabeler", () => {
  it("asks OpenAI not to store the request (store: false) and returns participants", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ participants: ["Sam"] }) }));
    }) as unknown as typeof fetch;
    const labeler = new OpenAiLabeler({ apiKey: "k", baseUrl: "https://api.test/v1", model: "gpt-6-luna", effort: "high", fetchImpl });
    const out = await labeler.label({ owner: "Peter", plaudTitle: "t", summaryMarkdown: "s", transcriptText: "x", knownParticipants: [] });
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(out.participants).toEqual(["Sam"]);
  });
});
