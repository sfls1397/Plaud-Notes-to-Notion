import { describe, expect, it } from "vitest";
import { emptyState } from "../src/state.js";
import { planGroup, runSync } from "../src/sync.js";
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
