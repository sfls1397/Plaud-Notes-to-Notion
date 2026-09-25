import {
  NOTION_RICH_TEXT_PER_BLOCK,
  NOTION_TEXT_CHUNK,
  NOTION_VERSION,
  TYPE_SUMMARY,
  TYPE_TRANSCRIPT
} from "./constants.js";
import { redactSecrets } from "./redact.js";

export type RowType = typeof TYPE_SUMMARY | typeof TYPE_TRANSCRIPT;

export interface NotionRow {
  id: string;
  title: string;
  types: string[];
  participants: string[];
  recorded: string | null;
  lastEdited: string;
}

export interface PlaudNotesSchema {
  typeKind: "select" | "multi_select";
  participantsKind: "select" | "multi_select";
  participantOptions: string[];
}

export interface NewRow {
  title: string;
  recorded: string;
  type: RowType;
  participants: string[];
}

export interface NotionStore {
  schema(): Promise<PlaudNotesSchema>;
  rowsAtMinute(minuteIso: string): Promise<NotionRow[]>;
  createSummary(row: NewRow, markdown: string): Promise<{ id: string; usedFallback: boolean }>;
  createTranscript(row: NewRow, text: string): Promise<{ id: string }>;
  summariesEditedSince(sinceIso: string): Promise<NotionRow[]>;
  rowsRecordedSince(sinceIso: string): Promise<NotionRow[]>;
  updateRow(pageId: string, patch: { title?: string; participants?: string[] }): Promise<void>;
}

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "NotionError";
  }
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403 || (this.status === 404 && this.code === "object_not_found");
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

type Json = Record<string, unknown>;

function plain(rich: unknown): string {
  return Array.isArray(rich) ? rich.map((r) => (r as { plain_text?: string }).plain_text || "").join("") : "";
}

function optionNames(prop: Json | undefined): string[] {
  if (!prop) {
    return [];
  }
  if (Array.isArray(prop.multi_select)) {
    return (prop.multi_select as Json[]).map((o) => String(o.name));
  }
  if (prop.select && typeof prop.select === "object") {
    return [String((prop.select as Json).name)];
  }
  return [];
}

export function rowFromPage(page: Json): NotionRow {
  const props = (page.properties || {}) as Record<string, Json>;
  const recorded = props.Recorded?.date as { start?: string } | null | undefined;
  return {
    id: String(page.id),
    title: plain(props.Meeting?.title),
    types: optionNames(props.Type),
    participants: optionNames(props.Participants),
    recorded: recorded?.start ?? null,
    lastEdited: String(page.last_edited_time || "")
  };
}

export function textToRichText(text: string): Array<Json> {
  const out: Json[] = [];
  for (let i = 0; i < text.length; i += NOTION_TEXT_CHUNK) {
    out.push({ type: "text", text: { content: text.slice(i, i + NOTION_TEXT_CHUNK) } });
  }
  return out;
}

/** One paragraph (like the Zap's) holding the whole transcript; split only past Notion's per-block cap. */
export function transcriptBlocks(text: string): Json[] {
  const rich = textToRichText(text);
  const blocks: Json[] = [];
  for (let i = 0; i < rich.length; i += NOTION_RICH_TEXT_PER_BLOCK) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: rich.slice(i, i + NOTION_RICH_TEXT_PER_BLOCK) }
    });
  }
  return blocks.length ? blocks : [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }];
}

/** Fallback when Notion cannot parse a summary as markdown: one plain paragraph per line. */
export function plainLineBlocks(markdown: string): Json[] {
  return markdown
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => ({ object: "block", type: "paragraph", paragraph: { rich_text: textToRichText(line) } }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpNotionStore implements NotionStore {
  private cachedSchema: { at: number; value: PlaudNotesSchema } | null = null;

  constructor(
    private readonly options: {
      token: string;
      dataSourceId: string;
      fetchImpl?: typeof fetch;
      sleepImpl?: (ms: number) => Promise<void>;
    }
  ) {}

  private async api(method: string, path: string, body?: unknown, attempt = 0): Promise<Json> {
    // Creates/appends are not idempotent: a 5xx can hide a success, so only reads retry on 5xx/network.
    // 429 is always safe to retry (Notion rejected it before doing anything).
    const idempotent = method === "GET" || path.endsWith("/query") || (method === "PATCH" && path.startsWith("/pages/"));
    let res: Response;
    try {
      res = await (this.options.fetchImpl || fetch)(`https://api.notion.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
      });
    } catch (err) {
      if (idempotent && attempt < 2) {
        await (this.options.sleepImpl || sleep)(2000 * (attempt + 1));
        return this.api(method, path, body, attempt + 1);
      }
      throw new NotionError(redactSecrets(`Notion unreachable (${err instanceof Error ? err.name : "network"})`), 0, "network");
    }
    if ((res.status === 429 || (idempotent && res.status >= 500)) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30, retryAfter) * 1000 : 1500 * (attempt + 1);
      await (this.options.sleepImpl || sleep)(wait);
      return this.api(method, path, body, attempt + 1);
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      throw new NotionError(
        redactSecrets(`Notion HTTP ${res.status}: ${String(json.message || json.code || "error")}`),
        res.status,
        String(json.code || "")
      );
    }
    return json;
  }

  private props(row: NewRow, schema: PlaudNotesSchema): Json {
    const multi = (kind: string, names: string[]) =>
      kind === "multi_select" ? { multi_select: names.map((name) => ({ name })) } : { select: names[0] ? { name: names[0] } : null };
    return {
      Meeting: { title: textToRichText(row.title) },
      Recorded: { date: { start: row.recorded } },
      Type: multi(schema.typeKind, [row.type]),
      Participants: multi(schema.participantsKind, row.participants)
    };
  }

  async schema(): Promise<PlaudNotesSchema> {
    if (this.cachedSchema && Date.now() - this.cachedSchema.at < 10 * 60_000) {
      return this.cachedSchema.value;
    }
    const ds = await this.api("GET", `/data_sources/${this.options.dataSourceId}`);
    const props = (ds.properties || {}) as Record<string, Json>;
    const missing = [
      ["Meeting", "title"],
      ["Recorded", "date"]
    ].filter(([name, type]) => props[name]?.type !== type);
    const kindOf = (name: string): "select" | "multi_select" | null =>
      props[name]?.type === "multi_select" ? "multi_select" : props[name]?.type === "select" ? "select" : null;
    const typeKind = kindOf("Type");
    const participantsKind = kindOf("Participants");
    if (missing.length || !typeKind || !participantsKind) {
      throw new NotionError(
        "Plaud Notes schema mismatch: need Meeting (title), Recorded (date), Type and Participants (select or multi-select)",
        400,
        "schema_mismatch"
      );
    }
    const optionsProp = props.Participants[participantsKind] as { options?: Json[] } | undefined;
    const value: PlaudNotesSchema = {
      typeKind,
      participantsKind,
      participantOptions: (optionsProp?.options || []).map((o) => String(o.name))
    };
    this.cachedSchema = { at: Date.now(), value };
    return value;
  }

  private async queryAll(filter: Json, sorts?: Json[]): Promise<NotionRow[]> {
    const rows: NotionRow[] = [];
    let cursor: string | undefined;
    do {
      const json = await this.api("POST", `/data_sources/${this.options.dataSourceId}/query`, {
        filter,
        sorts,
        page_size: 100,
        start_cursor: cursor
      });
      for (const page of (json.results || []) as Json[]) {
        rows.push(rowFromPage(page));
      }
      cursor = json.has_more ? String(json.next_cursor) : undefined;
    } while (cursor);
    return rows;
  }

  async rowsAtMinute(minuteIso: string): Promise<NotionRow[]> {
    const start = new Date(minuteIso);
    const end = new Date(start.getTime() + 60_000);
    return this.queryAll({
      and: [
        { property: "Recorded", date: { on_or_after: start.toISOString() } },
        { property: "Recorded", date: { before: end.toISOString() } }
      ]
    });
  }

  async createSummary(row: NewRow, markdown: string): Promise<{ id: string; usedFallback: boolean }> {
    const schema = await this.schema();
    const parent = { type: "data_source_id", data_source_id: this.options.dataSourceId };
    try {
      const page = await this.api("POST", "/pages", { parent, properties: this.props(row, schema), markdown });
      return { id: String(page.id), usedFallback: false };
    } catch (err) {
      if (!(err instanceof NotionError) || err.code !== "validation_error" || !/markdown/i.test(err.message)) {
        throw err;
      }
      const blocks = plainLineBlocks(markdown);
      const page = await this.api("POST", "/pages", { parent, properties: this.props(row, schema), children: blocks.slice(0, 100) });
      for (let i = 100; i < blocks.length; i += 100) {
        await this.api("PATCH", `/blocks/${String(page.id)}/children`, { children: blocks.slice(i, i + 100) });
      }
      return { id: String(page.id), usedFallback: true };
    }
  }

  async createTranscript(row: NewRow, text: string): Promise<{ id: string }> {
    const schema = await this.schema();
    const blocks = transcriptBlocks(text);
    const page = await this.api("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: this.options.dataSourceId },
      properties: this.props(row, schema),
      children: blocks.slice(0, 100)
    });
    for (let i = 100; i < blocks.length; i += 100) {
      await this.api("PATCH", `/blocks/${String(page.id)}/children`, { children: blocks.slice(i, i + 100) });
    }
    return { id: String(page.id) };
  }

  async summariesEditedSince(sinceIso: string): Promise<NotionRow[]> {
    const schema = await this.schema();
    const typeFilter =
      schema.typeKind === "multi_select"
        ? { property: "Type", multi_select: { contains: TYPE_SUMMARY } }
        : { property: "Type", select: { equals: TYPE_SUMMARY } };
    return this.queryAll({
      and: [typeFilter, { timestamp: "last_edited_time", last_edited_time: { on_or_after: sinceIso } }]
    });
  }

  async rowsRecordedSince(sinceIso: string): Promise<NotionRow[]> {
    return this.queryAll({ property: "Recorded", date: { on_or_after: sinceIso } }, [
      { property: "Recorded", direction: "descending" }
    ]);
  }

  async updateRow(pageId: string, patch: { title?: string; participants?: string[] }): Promise<void> {
    const schema = await this.schema();
    const properties: Json = {};
    if (patch.title !== undefined) {
      properties.Meeting = { title: textToRichText(patch.title) };
    }
    if (patch.participants !== undefined) {
      properties.Participants =
        schema.participantsKind === "multi_select"
          ? { multi_select: patch.participants.map((name) => ({ name })) }
          : { select: patch.participants[0] ? { name: patch.participants[0] } : null };
    }
    await this.api("PATCH", `/pages/${pageId}`, { properties });
  }
}
