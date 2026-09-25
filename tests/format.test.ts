import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cleanParticipants,
  cleanSummaryMarkdown,
  fallbackTitle,
  formatOffset,
  formatTranscript,
  recordedMinute,
  smartQuotes
} from "../src/format.js";

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("cleanSummaryMarkdown (Zap steps 3–5)", () => {
  it("matches the Zap's summary layout block-for-block, with paired quotes", () => {
    const out = cleanSummaryMarkdown(fixture("sales-call-summary.raw.md"));
    expect(out.split("\n")).toEqual([
      "## Core Synopsis",
      expect.stringContaining("offering its “gold tier” program ended quickly"),
      "## Call Deconstruction: A Pitch That Did Not Land",
      "### 1. The Opening",
      expect.stringContaining("Speaker 1, a relationship banker named Casey"),
      "### 2. The Rejection",
      expect.stringContaining("said, “I handle all of that myself now, thanks,” and"),
      "### 3. The Exit",
      "The banker offered contact details and promised a follow-up email.",
      "## Next Move",
      "**@Casey (Speaker 1)**:",
      "- [ ] Send a follow-up email with direct contact information - [TBD]"
    ]);
  });

  it("splits quoted speaker labels like the Zap's JavaScript step", () => {
    const out = cleanSummaryMarkdown(fixture("catch-up-summary.raw.md"));
    expect(out).toContain("**Speaker 3:**\n> “I start on Monday and I still can't believe it.”");
    expect(out).toContain("> “The interview was, and I mean this, 'the best conversation I've had all year.'”");
    expect(out).not.toMatch(/\n\s*\n/);
  });

  it("drops the PLAUD NOTE banner, Plaud image embeds and dividers", () => {
    const raw = "PLAUD NOTE\n## Title\n![mind map](\n permanent/abc/img.png)\n\nText\n\n---\n\nMore\n> **Label:**";
    expect(cleanSummaryMarkdown(raw)).toBe("## Title\nText\nMore\n**Label:**");
  });

  it("merges consecutive quote lines like the Zap, with list lines as the quote's children", () => {
    const raw = "> Date & Time: 2026-09-25 16:31:45\n> Location: [Insert Location]\n## Next\n- [ ] Follow up\n> AI Suggestions\n> The AI found:\n> 1. One\n> 2. Two";
    expect(cleanSummaryMarkdown(raw)).toBe(
      "> Date & Time: 2026-09-25 16:31:45<br>Location: [Insert Location]\n## Next\n- [ ] Follow up\n> AI Suggestions<br>The AI found:\n\t1. One\n\t2. Two"
    );
  });

  it("keeps every Memorable Moments quote (the Zap dropped all but the first)", () => {
    const out = cleanSummaryMarkdown(fixture("catch-up-summary.raw.md"));
    expect(out.match(/\*\*Speaker 3:\*\*\n> /g)).toHaveLength(3);
  });

  it("pairs straight quotes", () => {
    expect(smartQuotes('He said "hi" and ("bye").')).toBe("He said “hi” and (“bye”).");
  });
});

describe("formatTranscript", () => {
  it("matches the Zap's `Speaker N HH:MM:SS` layout without merging turns", () => {
    const text = formatTranscript([
      { speaker: "Speaker 1", startMs: 1270, text: "Hello. Hey, how they going?" },
      { speaker: "Speaker 3", startMs: 50890, text: "Yeah, I'm, but uh," },
      { speaker: "Speaker 3", startMs: 60060, text: "In in my" },
      { speaker: "Sam", startMs: 3_725_000, text: "Bye." }
    ]);
    expect(text).toBe(
      "Speaker 1 00:00:01\nHello. Hey, how they going?\nSpeaker 3 00:00:51\nYeah, I'm, but uh,\nSpeaker 3 00:01:00\nIn in my\nSam 01:02:05\nBye."
    );
    expect(formatOffset(0)).toBe("00:00:00");
  });
});

describe("recordedMinute", () => {
  it("is the true UTC start truncated to the minute (no +5h / DST hack)", () => {
    expect(recordedMinute(new Date("2026-09-25T20:00:25Z"))).toBe("2026-09-25T20:00:00.000Z");
    expect(recordedMinute(new Date("2026-12-01T19:05:59Z"))).toBe("2026-12-01T19:05:00.000Z");
  });
});

describe("cleanParticipants / fallbackTitle", () => {
  it("removes the owner, generic labels, commas and duplicates", () => {
    expect(cleanParticipants(["Peter", "Speaker 3", "Casey - Bank", "casey - bank", "Smith, John", "peter"], "Peter")).toEqual([
      "Casey - Bank",
      "Smith John"
    ]);
  });
  it("strips Plaud's date prefix", () => {
    expect(fallbackTitle("09-25 Failed Sales Call: Prospect's Expertise Disqualifies Offer")).toBe(
      "Failed Sales Call: Prospect's Expertise Disqualifies Offer"
    );
  });
});
