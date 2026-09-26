import { describe, expect, it } from "vitest";
import { emptyState } from "../src/state.js";
import { planGroup, runDeletionSync, runSync } from "../src/sync.js";
import { FakeNotion } from "./fakes.js";

function row(id: string, type: string, title: string, participants: string[], recorded = "2026-09-25T20:00:00.000Z") {
  return { id, types: [type], title, participants, recorded, lastEdited: "2026-09-25T20:05:00.000Z", body: "" };
}

describe("planGroup", () => {
  it("copies Summary title and participants onto the Transcript", () => {
    const plan = planGroup([row("s", "Summary", "Better Title", ["Casey - Bank"]), row("t", "Transcript", "Old Title", [])]);
    expect(plan).toMatchObject({ transcript: { id: "t" }, patch: { title: "Better Title", participants: ["Casey - Bank"] } });
  });
  it("treats participant order as irrelevant", () => {
    expect(planGroup([row("s", "Summary", "X", ["Sam", "Alex"]), row("t", "Transcript", "X", ["Alex", "Sam"])])).toBeNull();
  });
  it("skips ambiguous minutes", () => {
    expect(
      planGroup([row("s1", "Summary", "A", []), row("s2", "Summary", "B", []), row("t", "Transcript", "A", [])])
    ).toBe("ambiguous");
  });
  it("never copies Transcript edits back onto the Summary", () => {
    const plan = planGroup([row("s", "Summary", "Kept", ["Sam"]), row("t", "Transcript", "Kept", ["Sam", "Riley"])]);
    expect(plan).toMatchObject({ transcript: { id: "t" }, patch: { participants: ["Sam"] } });
  });
});

describe("runSync", () => {
  it("full reconcile on first run, then incremental on Summary edits only", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Form Status Check", ["Front Desk"]));
    notion.rows.push(row("t1", "Transcript", "Form Status Check", ["Receptionist"]));
    const state = emptyState();
    const logs: string[] = [];
    const base = { profile: "peter", notion, state, save: () => undefined, log: (m: string) => logs.push(m) };

    const first = await runSync({ ...base, now: () => new Date("2026-09-25T21:00:00Z") });
    expect(first.mode).toBe("full");
    expect(notion.rows.find((r) => r.id === "t1")?.participants).toEqual(["Front Desk"]);

    // Peter renames the Summary later.
    const s1 = notion.rows.find((r) => r.id === "s1")!;
    s1.title = "Form Status Follow-Up";
    s1.lastEdited = "2026-09-25T21:03:00.000Z";
    const second = await runSync({ ...base, now: () => new Date("2026-09-25T21:05:00Z") });
    expect(second.mode).toBe("incremental");
    expect(notion.rows.find((r) => r.id === "t1")?.title).toBe("Form Status Follow-Up");
    expect(notion.updates).toHaveLength(2);
  });

  it("dry run changes nothing", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s", "Summary", "New", []), row("t", "Transcript", "Old", []));
    const r = await runSync({ profile: "p", notion, state: emptyState(), save: () => undefined, log: () => undefined, dryRun: true });
    expect(r.updated).toHaveLength(1);
    expect(notion.updates).toHaveLength(0);
  });
});

describe("runDeletionSync", () => {
  const base = (notion: FakeNotion, state = emptyState(), now = "2026-09-26T21:00:00Z") => ({
    profile: "peter",
    notion,
    state,
    save: () => undefined,
    log: () => undefined,
    now: () => new Date(now)
  });

  it("trashes the Transcript when its Summary is moved to the trash", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Call", []));
    const state = emptyState();
    expect((await runDeletionSync(base(notion, state))).tracked).toBe(1); // first pass only learns the pair
    notion.rows.find((r) => r.id === "s1")!.inTrash = true;
    const r = await runDeletionSync(base(notion, state));
    expect(r.trashed).toEqual([{ transcriptId: "t1", minute: "2026-09-25T20:00:00.000Z" }]);
    expect(notion.rows.find((r) => r.id === "t1")?.inTrash).toBe(true);
  });

  it("restores the Transcript when the Summary is restored from the trash", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Call", []));
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    notion.rows.find((r) => r.id === "s1")!.inTrash = true;
    await runDeletionSync(base(notion, state));
    notion.rows.find((r) => r.id === "s1")!.inTrash = false;
    const r = await runDeletionSync(base(notion, state));
    expect(r.restored).toHaveLength(1);
    expect(notion.rows.find((r) => r.id === "t1")?.inTrash).toBe(false);
  });

  it("never deletes a Summary when only the Transcript is trashed", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Call", []));
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    notion.rows.find((r) => r.id === "t1")!.inTrash = true;
    await runDeletionSync(base(notion, state));
    expect(notion.trashCalls).toEqual([]);
    expect(notion.rows.find((r) => r.id === "s1")?.inTrash).toBeFalsy();
  });

  it("does nothing when a Summary 404s (lost access / permanent delete) instead of being in the trash", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Call", []));
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    notion.gone.add("s1");
    const r = await runDeletionSync(base(notion, state));
    expect(r.trashed).toEqual([]);
    expect(notion.trashCalls).toEqual([]);
  });

  it("does not touch Transcripts in ambiguous minutes or with no Summary pair ever seen", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "A", []), row("s2", "Summary", "B", []), row("t1", "Transcript", "A", []));
    notion.rows.push(row("t9", "Transcript", "Orphan", [], "2026-09-24T10:00:00.000Z"));
    const state = emptyState();
    const r = await runDeletionSync(base(notion, state));
    expect(r.tracked).toBe(0);
    notion.rows.find((r) => r.id === "s1")!.inTrash = true;
    await runDeletionSync(base(notion, state));
    expect(notion.trashCalls).toEqual([]);
  });

  it("dry run reports but changes nothing", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Call", []));
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    notion.rows.find((r) => r.id === "s1")!.inTrash = true;
    const r = await runDeletionSync({ ...base(notion, state), dryRun: true });
    expect(r.trashed).toHaveLength(1);
    expect(notion.trashCalls).toEqual([]);
  });
});
