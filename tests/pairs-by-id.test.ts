import { describe, expect, it } from "vitest";
import { runIngest, type IngestDeps } from "../src/ingest.js";
import { emptyState, type ProfileState } from "../src/state.js";
import { backfillPairsFromFiles, runDeletionSync, runSync } from "../src/sync.js";
import { FakeLabeler, FakeNotion, FakePlaud } from "./fakes.js";

function row(id: string, type: string, title: string, participants: string[], recorded = "2026-09-25T20:00:00.000Z") {
  return { id, types: [type], title, participants, recorded, lastEdited: "2026-09-25T20:05:00.000Z", body: "" };
}

function ingestDeps(notion = new FakeNotion(), state: ProfileState = emptyState()): IngestDeps & { plaud: FakePlaud; notion: FakeNotion; state: ProfileState } {
  return {
    profile: "example",
    owner: "Alex Example",
    startAfter: new Date("2026-09-26T00:00:00Z"),
    plaud: new FakePlaud(),
    notion,
    labeler: new FakeLabeler(),
    state,
    save: () => undefined,
    log: () => undefined,
    now: () => new Date("2026-09-26T15:01:00Z")
  } as never;
}

describe("pairs by page id", () => {
  it("a written recording is paired by its two page ids; re-running it reuses those pages and creates nothing", async () => {
    const d = ingestDeps();
    d.plaud.add({ id: "of_1" });
    await runIngest(d);
    const [s, t] = d.notion.rows;
    expect(d.state.pairs?.[s.id]).toEqual({ transcriptId: t.id, minute: "2026-09-26T14:50:00.000Z" });

    // Re-run the same recording (state back to pending, page ids kept): no lookup by minute, nothing new.
    d.state.files.of_1.status = "pending";
    d.notion.lookups.length = 0;
    const again = await runIngest(d);
    expect(again.errors).toEqual([]);
    expect(d.notion.rows.map((r) => r.id)).toEqual([s.id, t.id]);
    expect(d.notion.lookups.filter((l) => l.startsWith("minute"))).toEqual([]);
    expect(d.state.files.of_1).toMatchObject({ status: "done", summaryPageId: s.id, transcriptPageId: t.id });
  });

  it("the title sync updates the paired Transcript by id, even after the Summary's Recorded minute is edited", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", ["Sam"]), row("t1", "Transcript", "Call", ["Sam"]));
    const state = emptyState();
    state.pairs = { s1: { transcriptId: "t1", minute: "2026-09-25T20:00:00.000Z" } };
    state.lastSyncAt = "2026-09-25T21:00:00.000Z";
    state.lastFullSyncAt = "2026-09-25T21:00:00.000Z";
    const s1 = notion.rows.find((r) => r.id === "s1")!;
    s1.title = "Renamed Call";
    s1.recorded = "2026-09-25T20:07:00.000Z"; // no longer in the Transcript's minute
    s1.lastEdited = "2026-09-25T21:03:00.000Z";

    const r = await runSync({ profile: "p", notion, state, save: () => undefined, log: () => undefined, now: () => new Date("2026-09-25T21:05:00Z") });
    expect(r.mode).toBe("incremental");
    expect(notion.updates).toEqual([{ id: "t1", patch: { title: "Renamed Call" } }]);
    expect(notion.lookups).toEqual(["id t1"]);
    expect(notion.rows).toHaveLength(2);
  });

  it("a Summary with no pair is matched by Recorded minute once, then by id", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Old", []));
    const state = emptyState();
    const base = { profile: "p", notion, state, save: () => undefined, log: () => undefined };
    await runSync({ ...base, now: () => new Date("2026-09-25T21:00:00Z") });
    expect(state.pairs).toEqual({ s1: { transcriptId: "t1", minute: "2026-09-25T20:00:00.000Z" } });
    expect(notion.rows.find((r) => r.id === "t1")?.title).toBe("Call");

    const s1 = notion.rows.find((r) => r.id === "s1")!;
    s1.title = "Call Two";
    s1.lastEdited = "2026-09-25T21:03:00.000Z";
    notion.lookups.length = 0;
    await runSync({ ...base, now: () => new Date("2026-09-25T21:05:00Z") });
    expect(notion.lookups).toEqual(["id t1"]);
    expect(notion.rows.find((r) => r.id === "t1")?.title).toBe("Call Two");
  });

  it("never pairs a Transcript that already belongs to another Summary", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s2", "Summary", "Dup", []), row("t1", "Transcript", "Call", []));
    const state = emptyState();
    state.pairs = { s1: { transcriptId: "t1", minute: "2026-09-25T20:00:00.000Z" } };
    const r = await runSync({ profile: "p", notion, state, save: () => undefined, log: () => undefined, now: () => new Date("2026-09-25T21:00:00Z") });
    expect(r.ambiguous).toBe(1);
    expect(notion.updates).toEqual([]);
    expect(state.pairs.s2).toBeUndefined();
  });

  it("backfills pairs from the file state, and keeps pairs older than the deletion window", async () => {
    const state = emptyState();
    state.files.of_1 = { status: "done", firstSeen: "2026-06-01T00:00:00Z", llmAttempts: 0, recorded: "2026-06-01T10:00:30.000Z", summaryPageId: "s-old", transcriptPageId: "t-old" };
    expect(backfillPairsFromFiles(state)).toBe(1);
    expect(state.pairs).toEqual({ "s-old": { transcriptId: "t-old", minute: "2026-06-01T10:00:00.000Z" } });

    const notion = new FakeNotion();
    await runDeletionSync({ profile: "p", notion, state, save: () => undefined, log: () => undefined, now: () => new Date("2026-11-02T21:00:00Z") });
    expect(state.pairs?.["s-old"]).toBeDefined();
    expect(notion.lookups).toEqual([]);
  });
});
