import type { LabelInput, Labeler, RecordingLabels } from "../src/llm.js";
import type { NewRow, NotionRow, NotionStore, PlaudNotesSchema } from "../src/notion.js";
import type { PlaudClient, PlaudFileListing, PlaudRecording } from "../src/plaud/client.js";

export class FakePlaud implements PlaudClient {
  recordings = new Map<string, PlaudRecording>();
  listCalls: number[] = [];

  add(rec: Partial<PlaudRecording> & { id: string }): PlaudRecording {
    const full: PlaudRecording = {
      name: `09-25 Recording ${rec.id}`,
      createdAt: new Date("2026-09-26T15:00:00Z"),
      startAt: new Date("2026-09-26T14:50:10Z"),
      durationMs: 60_000,
      summaryMarkdown: "## Core Synopsis\nA short call.",
      segments: [{ speaker: "Speaker 1", startMs: 0, text: "Hello there." }],
      ...rec
    };
    this.recordings.set(rec.id, full);
    return full;
  }

  async listFiles(page = 1, pageSize = 20): Promise<PlaudFileListing[]> {
    this.listCalls.push(page);
    const all = [...this.recordings.values()].sort((a, b) => (b.startAt?.getTime() ?? 0) - (a.startAt?.getTime() ?? 0));
    return all.slice((page - 1) * pageSize, page * pageSize).map(({ id, name, createdAt, startAt, durationMs }) => ({
      id,
      name,
      createdAt,
      startAt,
      durationMs
    }));
  }

  async getRecording(fileId: string): Promise<PlaudRecording> {
    const r = this.recordings.get(fileId);
    if (!r) {
      throw new Error("not found");
    }
    return structuredClone(r);
  }

  async currentUser(): Promise<Record<string, unknown>> {
    return {};
  }
}

export class FakeNotion implements NotionStore {
  rows: Array<NotionRow & { body: string }> = [];
  failNextCreate: "summary" | "transcript" | null = null;
  updates: Array<{ id: string; patch: { title?: string; participants?: string[] } }> = [];
  private n = 0;
  options = ["Casey - Bank", "Sam", "Alex"];

  async schema(): Promise<PlaudNotesSchema> {
    return { typeKind: "multi_select", participantsKind: "multi_select", participantOptions: this.options };
  }

  private add(row: NewRow, body: string): { id: string } {
    const id = `page-${++this.n}`;
    this.rows.push({
      id,
      title: row.title,
      types: [row.type],
      participants: row.participants,
      recorded: row.recorded,
      lastEdited: new Date().toISOString(),
      body
    });
    return { id };
  }

  async rowsAtMinute(minuteIso: string): Promise<NotionRow[]> {
    const t = Date.parse(minuteIso);
    return this.rows.filter((r) => r.recorded && Date.parse(r.recorded) >= t && Date.parse(r.recorded) < t + 60_000);
  }

  async createSummary(row: NewRow, markdown: string) {
    if (this.failNextCreate === "summary") {
      this.failNextCreate = null;
      throw Object.assign(new Error("Notion HTTP 502"), { status: 502 });
    }
    return { ...this.add(row, markdown), usedFallback: false };
  }

  async createTranscript(row: NewRow, text: string) {
    if (this.failNextCreate === "transcript") {
      this.failNextCreate = null;
      throw Object.assign(new Error("Notion HTTP 502"), { status: 502 });
    }
    return this.add(row, text);
  }

  async summariesEditedSince(sinceIso: string): Promise<NotionRow[]> {
    return this.rows.filter((r) => r.types.includes("Summary") && r.lastEdited >= sinceIso);
  }

  async rowsRecordedSince(sinceIso: string): Promise<NotionRow[]> {
    return this.rows.filter((r) => r.recorded && r.recorded >= sinceIso);
  }

  async updateRow(pageId: string, patch: { title?: string; participants?: string[] }): Promise<void> {
    this.updates.push({ id: pageId, patch });
    const row = this.rows.find((r) => r.id === pageId);
    if (row) {
      Object.assign(row, patch.title !== undefined ? { title: patch.title } : {});
      if (patch.participants) {
        row.participants = patch.participants;
      }
    }
  }
}

export class FakeLabeler implements Labeler {
  calls: LabelInput[] = [];
  failures = 0;
  constructor(private readonly result: RecordingLabels = { title: "A Short Call", participants: ["Sam", "Peter"] }) {}
  async label(input: LabelInput): Promise<RecordingLabels> {
    this.calls.push(input);
    if (this.failures > 0) {
      this.failures--;
      throw Object.assign(new Error("OpenAI HTTP 503"), { transient: true });
    }
    return this.result;
  }
}
