import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { HttpPlaudClient, parsePlaudTime, segmentsFromUnknown } from "../src/plaud/client.js";
import type { PlaudAuthSession } from "../src/plaud/session.js";

function session(tokens: string[]): PlaudAuthSession & { refreshes: number } {
  let i = 0;
  const s = {
    refreshes: 0,
    endpoints: { clientId: "c", redirectUri: "r", authorizationUrl: "a", tokenUrl: "t", refreshUrl: "f", apiBase: "https://plaud.test/api" },
    getAccessToken: async () => tokens[i],
    refresh: async () => {
      s.refreshes++;
      i++;
      return tokens[i];
    },
    save: async () => undefined,
    clear: async () => undefined,
    peek: () => ({ access_token: tokens[i] })
  };
  return s;
}

describe("parsePlaudTime", () => {
  it("treats Plaud's naive ISO strings as UTC", () => {
    expect(parsePlaudTime("2026-09-25T20:00:25")?.toISOString()).toBe("2026-09-25T20:00:25.000Z");
  });
  it("accepts zoned strings and epoch seconds/ms", () => {
    expect(parsePlaudTime("2026-09-25T15:00:25-05:00")?.toISOString()).toBe("2026-09-25T20:00:25.000Z");
    expect(parsePlaudTime(1790366425)?.toISOString()).toBe("2026-09-25T20:00:25.000Z");
    expect(parsePlaudTime(1790366425000)?.toISOString()).toBe("2026-09-25T20:00:25.000Z");
    expect(parsePlaudTime("nope")).toBeNull();
  });
});

describe("segmentsFromUnknown", () => {
  it("reads Plaud transaction segments", () => {
    expect(
      segmentsFromUnknown([
        { content: "Hello.", start_time: 160, end_time: 480, speaker: "Speaker 1", original_speaker: "Speaker 1" },
        { content: "", start_time: 500, speaker: "Speaker 2" }
      ])
    ).toEqual([{ speaker: "Speaker 1", startMs: 160, text: "Hello." }]);
  });
});

describe("HttpPlaudClient", () => {
  const file = {
    id: "of_1",
    name: "09-26 Test",
    created_at: "2026-09-26T15:00:00",
    start_at: "2026-09-26T14:50:10",
    duration: 60000,
    note_list: [{ data_type: "auto_sum_note", data_content: "", data_link: "https://s3.test/sum.md.gz" }],
    source_list: [
      { data_type: "transaction", data_content: JSON.stringify([{ content: "Hi.", start_time: 0, speaker: "Speaker 1" }]) },
      { data_type: "outline", data_content: "[]" }
    ]
  };

  it("loads a recording, gunzipping linked blocks, and retries once after a 401", async () => {
    const s = session(["old", "new"]);
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      seen.push(`${url.replace("https://", "")} ${auth || ""}`);
      if (url.startsWith("https://s3.test/")) {
        return new Response(gzipSync(Buffer.from("## Core Synopsis\nGzipped summary.")));
      }
      if (auth === "Bearer old") {
        return new Response("{}", { status: 401 });
      }
      return new Response(JSON.stringify({ data: file }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new HttpPlaudClient(s, { fetchImpl });
    const rec = await client.getRecording("of_1");
    expect(s.refreshes).toBe(1);
    expect(rec.summaryMarkdown).toBe("## Core Synopsis\nGzipped summary.");
    expect(rec.segments).toEqual([{ speaker: "Speaker 1", startMs: 0, text: "Hi." }]);
    expect(rec.startAt?.toISOString()).toBe("2026-09-26T14:50:10.000Z");
    expect(seen.some((l) => l.includes("s3.test") && l.includes("Bearer"))).toBe(false); // never send the Plaud token to S3
  });

  it("reports a still-generating summary as null", async () => {
    const pending = { ...file, note_list: [] };
    const fetchImpl = (async () => new Response(JSON.stringify({ data: pending }))) as unknown as typeof fetch;
    const rec = await new HttpPlaudClient(session(["t"]), { fetchImpl }).getRecording("of_1");
    expect(rec.summaryMarkdown).toBeNull();
  });

  it("rejects file ids that could escape the API path", async () => {
    const client = new HttpPlaudClient(session(["t"]), { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(client.getRecording("../users/current")).rejects.toThrow("Invalid Plaud file id");
  });
});
