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
  const pair = () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "Call", []), row("t1", "Transcript", "Call", []));
    return notion;
  };
  const trash = (n: FakeNotion, id: string, v = true) => (n.rows.find((r) => r.id === id)!.inTrash = v);
  const inTrash = (n: FakeNotion, id: string) => Boolean(n.rows.find((r) => r.id === id)?.inTrash);

  it("deleting the Summary deletes the Transcript", async () => {
    const notion = pair();
    const state = emptyState();
    expect((await runDeletionSync(base(notion, state))).tracked).toBe(1); // first pass only learns the pair
    trash(notion, "s1");
    const r = await runDeletionSync(base(notion, state));
    expect(r.trashed).toEqual([{ pageId: "t1", side: "transcript", minute: "2026-09-25T20:00:00.000Z" }]);
    expect(inTrash(notion, "t1")).toBe(true);
  });

  it("deleting the Transcript deletes the Summary", async () => {
    const notion = pair();
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    trash(notion, "t1");
    const r = await runDeletionSync(base(notion, state));
    expect(r.trashed).toEqual([{ pageId: "s1", side: "summary", minute: "2026-09-25T20:00:00.000Z" }]);
    expect(inTrash(notion, "s1")).toBe(true);
  });

  it("restoring either side restores the other (both directions)", async () => {
    for (const [deleted, restored, partner] of [["s1", "s1", "t1"], ["s1", "t1", "s1"], ["t1", "t1", "s1"], ["t1", "s1", "t1"]]) {
      const notion = pair();
      const state = emptyState();
      await runDeletionSync(base(notion, state));
      trash(notion, deleted);
      await runDeletionSync(base(notion, state)); // partner auto-trashed
      expect(inTrash(notion, "s1") && inTrash(notion, "t1")).toBe(true);
      trash(notion, restored, false); // user restores one side from the trash
      const r = await runDeletionSync(base(notion, state));
      expect(r.restored.map((x) => x.pageId)).toEqual([partner]);
      expect(inTrash(notion, "s1") || inTrash(notion, "t1")).toBe(false);
    }
  });

  it("when both were deleted by hand, restoring one restores the other", async () => {
    const notion = pair();
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    trash(notion, "s1");
    trash(notion, "t1");
    const r = await runDeletionSync(base(notion, state));
    expect(r.trashed).toEqual([]); // nothing left to trash
    trash(notion, "t1", false);
    await runDeletionSync(base(notion, state));
    expect(inTrash(notion, "s1")).toBe(false);
  });

  it("does nothing when a page 404s (lost access / permanent delete) instead of being in the trash", async () => {
    for (const id of ["s1", "t1"]) {
      const notion = pair();
      const state = emptyState();
      await runDeletionSync(base(notion, state));
      notion.gone.add(id);
      const r = await runDeletionSync(base(notion, state));
      expect(r.trashed).toEqual([]);
      expect(notion.trashCalls).toEqual([]);
    }
  });

  it("does not touch ambiguous minutes or orphan Transcripts", async () => {
    const notion = new FakeNotion();
    notion.rows.push(row("s1", "Summary", "A", []), row("s2", "Summary", "B", []), row("t1", "Transcript", "A", []));
    notion.rows.push(row("t9", "Transcript", "Orphan", [], "2026-09-24T10:00:00.000Z"));
    const state = emptyState();
    expect((await runDeletionSync(base(notion, state))).tracked).toBe(0);
    trash(notion, "s1");
    trash(notion, "t9");
    await runDeletionSync(base(notion, state));
    expect(notion.trashCalls).toEqual([]);
  });

  it("dry run reports but changes nothing", async () => {
    const notion = pair();
    const state = emptyState();
    await runDeletionSync(base(notion, state));
    trash(notion, "t1");
    const r = await runDeletionSync({ ...base(notion, state), dryRun: true });
    expect(r.trashed).toHaveLength(1);
    expect(notion.trashCalls).toEqual([]);
  });
});
