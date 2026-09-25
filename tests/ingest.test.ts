import { describe, expect, it } from "vitest";
import { LLM_MAX_ATTEMPTS } from "../src/constants.js";
import { runIngest, type IngestDeps } from "../src/ingest.js";
import { emptyState, type ProfileState } from "../src/state.js";
import { SSN_REPLACEMENT } from "../src/ssn.js";
import { FakeLabeler, FakeNotion, FakePlaud } from "./fakes.js";

function deps(over: Partial<IngestDeps> = {}): IngestDeps & { plaud: FakePlaud; notion: FakeNotion; labeler: FakeLabeler; state: ProfileState; logs: string[] } {
  const logs: string[] = [];
  const d = {
    profile: "peter",
    owner: "Peter",
    startAfter: new Date("2026-09-26T00:00:00Z"),
    plaud: new FakePlaud(),
    notion: new FakeNotion(),
    labeler: new FakeLabeler(),
    state: emptyState(),
    save: () => undefined,
    log: (m: string) => logs.push(m),
    now: () => new Date("2026-09-26T15:01:00Z"),
    logs,
    ...over
  };
  return d as never;
}

describe("runIngest", () => {
  it("writes a Summary then a Transcript row with identical title/participants/Recorded", async () => {
    const d = deps();
    d.plaud.add({ id: "of_1" });
    const r = await runIngest(d);
    expect(r.written).toHaveLength(1);
    const [s, t] = d.notion.rows;
    expect(s.types).toEqual(["Summary"]);
    expect(t.types).toEqual(["Transcript"]);
    for (const row of [s, t]) {
      expect(row.title).toBe("A Short Call");
      expect(row.participants).toEqual(["Sam"]); // owner stripped
      expect(row.recorded).toBe("2026-09-26T14:50:00.000Z");
    }
    expect(t.body).toBe("Speaker 1 00:00:00\nHello there.");
    expect(d.state.files.of_1.status).toBe("done");
  });

  it("ignores recordings uploaded before startAfter (the Zap already wrote them)", async () => {
    const d = deps();
    d.plaud.add({ id: "old", createdAt: new Date("2026-09-25T20:02:25Z"), startAt: new Date("2026-09-25T20:00:25Z") });
    d.plaud.add({ id: "new" });
    await runIngest(d);
    expect(d.notion.rows.map((r) => r.types[0])).toEqual(["Summary", "Transcript"]);
    expect(d.state.files.old).toBeUndefined();
  });

  it("waits while Plaud is still generating the summary, then writes once ready", async () => {
    const d = deps();
    d.plaud.add({ id: "of_1", summaryMarkdown: null });
    let r = await runIngest(d);
    expect(r.pending).toBe(1);
    expect(d.notion.rows).toHaveLength(0);
    d.plaud.recordings.get("of_1")!.summaryMarkdown = "## Core Synopsis\nDone now.";
    r = await runIngest(d);
    expect(r.written).toHaveLength(1);
    expect(d.notion.rows).toHaveLength(2);
    expect(d.labeler.calls).toHaveLength(1);
  });

  it("does not reprocess finished recordings on later polls", async () => {
    const d = deps();
    d.plaud.add({ id: "of_1" });
    await runIngest(d);
    await runIngest(d);
    expect(d.notion.rows).toHaveLength(2);
    expect(d.labeler.calls).toHaveLength(1);
  });

  it("redacts SSNs before the labeler or Notion ever see the text", async () => {
    const d = deps();
    d.plaud.add({
      id: "of_1",
      summaryMarkdown: "## Background\nIdentity verified (last four digits of SSN: 4417).",
      segments: [
        { speaker: "Speaker 2", startMs: 1000, text: "What are the last four digits of your social security number?" },
        { speaker: "Speaker 1", startMs: 5000, text: "Four four one seven." }
      ]
    });
    await runIngest(d);
    const everything = JSON.stringify([d.labeler.calls, d.notion.rows]);
    expect(everything).not.toContain("4417");
    expect(everything).not.toMatch(/four four one seven/i);
    expect(d.notion.rows[1].body).toContain(`Speaker 1 00:00:05\n${SSN_REPLACEMENT}.`);
    expect(d.state.files.of_1.ssnRedactions).toBe(2);
  });

  it("finishes a half-written recording without duplicating the Summary", async () => {
    const d = deps();
    d.plaud.add({ id: "of_1" });
    d.notion.failNextCreate = "transcript";
    let r = await runIngest(d);
    expect(r.errors).toHaveLength(1);
    expect(d.notion.rows.map((x) => x.types[0])).toEqual(["Summary"]);
    r = await runIngest(d);
    expect(d.notion.rows.map((x) => x.types[0])).toEqual(["Summary", "Transcript"]);
    expect(d.labeler.calls).toHaveLength(1); // labels reused, rows match
  });

  it("recovers when a create secretly succeeded but state was lost (same minute+type+title)", async () => {
    const d = deps();
    d.plaud.add({ id: "of_1" });
    await runIngest(d);
    // Simulate a crash that lost page ids but kept labels.
    const f = d.state.files.of_1;
    f.status = "pending";
    delete f.summaryPageId;
    delete f.transcriptPageId;
    await runIngest(d);
    expect(d.notion.rows).toHaveLength(2);
  });

  it("writes two different recordings that start in the same minute", async () => {
    const d = deps({ labeler: undefined as never });
    let n = 0;
    d.labeler = new FakeLabeler();
    d.labeler.label = async () => ({ title: `Call ${++n}`, participants: [] });
    d.plaud.add({ id: "a", startAt: new Date("2026-09-26T14:50:05Z"), createdAt: new Date("2026-09-26T15:00:00Z") });
    d.plaud.add({ id: "b", startAt: new Date("2026-09-26T14:50:40Z"), createdAt: new Date("2026-09-26T15:00:30Z") });
    await runIngest(d);
    expect(d.notion.rows.map((r) => `${r.types[0]}:${r.title}`)).toEqual([
      "Summary:Call 1",
      "Transcript:Call 1",
      "Summary:Call 2",
      "Transcript:Call 2"
    ]);
  });

  it("retries labeling, then falls back to Plaud's title so the recording is never lost", async () => {
    const d = deps();
    d.plaud.add({ id: "of_1", name: "09-26 Budget Review With Jim" });
    d.labeler.failures = 99;
    for (let i = 1; i < LLM_MAX_ATTEMPTS; i++) {
      const r = await runIngest(d);
      expect(r.pending).toBe(1);
      expect(d.notion.rows).toHaveLength(0);
    }
    await runIngest(d);
    expect(d.notion.rows.map((r) => r.title)).toEqual(["Budget Review With Jim", "Budget Review With Jim"]);
    expect(d.state.files.of_1.labelSource).toBe("fallback");
  });

  it("dry run writes nothing", async () => {
    const d = deps({ dryRun: true });
    d.plaud.add({ id: "of_1" });
    const r = await runIngest(d);
    expect(r.written).toHaveLength(1);
    expect(d.notion.rows).toHaveLength(0);
  });

  it("deep scan finds an offline recording uploaded late (old start, new upload)", async () => {
    const d = deps();
    for (let i = 0; i < 25; i++) {
      d.plaud.add({
        id: `recent${i}`,
        startAt: new Date(Date.parse("2026-09-26T14:00:00Z") - i * 60_000),
        createdAt: new Date("2026-09-25T10:00:00Z") // before startAfter: already handled by the Zap
      });
    }
    d.plaud.add({ id: "late", startAt: new Date("2026-09-24T09:00:00Z"), createdAt: new Date("2026-09-26T14:59:00Z") });
    expect((await runIngest(d)).written).toHaveLength(0); // page 1 only
    expect((await runIngest(d, { deep: true })).written.map((w) => w.id)).toEqual(["late"]);
  });
});
