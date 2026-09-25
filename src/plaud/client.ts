import { gunzipSync } from "node:zlib";
import { AuthExpiredError, isAuthExpiredError, isTransportError } from "./errors.js";
import type { PlaudAuthSession } from "./session.js";
import { redactSecrets } from "../redact.js";

/** One recording as listed by Plaud. Times are UTC instants. */
export interface PlaudFileListing {
  id: string;
  name: string;
  /** When the file landed in Plaud (upload/sync). Drives the ingest watermark. */
  createdAt: Date | null;
  /** When recording started. Becomes Notion `Recorded`. */
  startAt: Date | null;
  durationMs: number | null;
}

export interface PlaudSegment {
  speaker: string;
  startMs: number;
  text: string;
}

export interface PlaudRecording extends PlaudFileListing {
  /** Plaud's auto summary markdown (`auto_sum_note`), or null while it is still generating. */
  summaryMarkdown: string | null;
  /** Raw transcript segments (`transaction` block), empty while still generating. */
  segments: PlaudSegment[];
}

export interface PlaudClient {
  listFiles(page?: number, pageSize?: number): Promise<PlaudFileListing[]>;
  getRecording(fileId: string): Promise<PlaudRecording>;
  currentUser(): Promise<Record<string, unknown>>;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Plaud's third-party API returns naive ISO strings that are UTC
 * (e.g. start_at 2026-09-25T20:00:25 for a 3:00 PM CDT call); epoch seconds or
 * milliseconds are accepted too.
 */
export function parsePlaudTime(value: unknown): Date | null {
  const n = asNumber(value);
  if (n !== null) {
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = asString(value);
  if (!s) {
    return null;
  }
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());
  const d = new Date(hasZone ? s : `${s.trim().replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function assertFileId(fileId: string): string {
  const id = typeof fileId === "string" ? fileId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Invalid Plaud file id");
  }
  return id;
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    const data = obj.data as Record<string, unknown>;
    if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
      return data.data as Record<string, unknown>;
    }
    return data;
  }
  return obj;
}

export function extractFileList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const obj = payload as Record<string, unknown>;
  const data = obj.data as Record<string, unknown> | undefined;
  for (const c of [obj.data_list, obj.files, obj.items, obj.data, data?.data_list, data?.files, data?.items, data?.data]) {
    if (Array.isArray(c)) {
      return c.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    }
  }
  return [];
}

export function normalizeListing(raw: Record<string, unknown>): PlaudFileListing {
  const id = asString(raw.id) || asString(raw.file_id);
  if (!id) {
    throw new Error("Plaud file payload missing id");
  }
  return {
    id,
    name: asString(raw.name) || asString(raw.filename) || asString(raw.title) || "Untitled recording",
    createdAt: parsePlaudTime(raw.created_at ?? raw.createdAt ?? raw.start_at),
    startAt: parsePlaudTime(raw.start_at ?? raw.startAt ?? raw.start_time),
    durationMs: asNumber(raw.duration) ?? asNumber(raw.duration_ms)
  };
}

export function segmentsFromUnknown(list: unknown): PlaudSegment[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const out: PlaudSegment[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const text = asString(rec.content) ?? asString(rec.text) ?? asString(rec.sentence);
    if (!text) {
      continue;
    }
    out.push({
      speaker: asString(rec.speaker) || asString(rec.original_speaker) || "Speaker",
      startMs: asNumber(rec.start_time) ?? asNumber(rec.start) ?? asNumber(rec.start_ms) ?? 0,
      text
    });
  }
  return out;
}

function decodeBlock(buf: Buffer): string {
  const bytes = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return bytes.toString("utf8");
}

const MAX_BLOCK_BYTES = 30 * 1024 * 1024;

export async function fetchHttpsBlock(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Plaud block URL must be plain https");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetchImpl(url, { redirect: "error", signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`Plaud block fetch HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BLOCK_BYTES) {
      throw new Error("Plaud block too large");
    }
    return decodeBlock(buf);
  } finally {
    clearTimeout(timer);
  }
}

export class HttpPlaudClient implements PlaudClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(
    private readonly session: PlaudAuthSession,
    options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}
  ) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.baseUrl = (options.baseUrl || session.endpoints.apiBase).replace(/\/$/, "");
  }

  async listFiles(page = 1, pageSize = 20): Promise<PlaudFileListing[]> {
    const payload = await this.requestJson(`/open/third-party/files/?page=${page}&page_size=${Math.max(10, pageSize)}`);
    return extractFileList(payload).map(normalizeListing);
  }

  async currentUser(): Promise<Record<string, unknown>> {
    return unwrap(await this.requestJson("/open/third-party/users/current")) || {};
  }

  async getRecording(fileId: string): Promise<PlaudRecording> {
    const id = assertFileId(fileId);
    const record = unwrap(await this.requestJson(`/open/third-party/files/${encodeURIComponent(id)}`));
    if (!record) {
      throw new Error("Plaud file not found");
    }
    const listing = normalizeListing(record);
    return {
      ...listing,
      summaryMarkdown: await this.autoSummary(record),
      segments: await this.transcriptSegments(record)
    };
  }

  private async blockContent(block: Record<string, unknown>): Promise<string> {
    const inline = asString(block.data_content);
    if (inline) {
      return inline;
    }
    const link = asString(block.data_link);
    return link ? fetchHttpsBlock(link, this.fetchImpl) : "";
  }

  /** The Summary tab (`auto_sum_note`) — what the Zap's "Summary" field carried. */
  private async autoSummary(record: Record<string, unknown>): Promise<string | null> {
    const notes = Array.isArray(record.note_list) ? (record.note_list as Record<string, unknown>[]) : [];
    const note = notes.find((n) => n && n.data_type === "auto_sum_note");
    if (!note) {
      return null;
    }
    const text = (await this.blockContent(note)).trim();
    return text || null;
  }

  private async transcriptSegments(record: Record<string, unknown>): Promise<PlaudSegment[]> {
    const sources = Array.isArray(record.source_list) ? (record.source_list as Record<string, unknown>[]) : [];
    const block = sources.find((s) => s && s.data_type === "transaction");
    if (!block) {
      return [];
    }
    const content = await this.blockContent(block);
    if (!content.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.segments ?? (parsed as Record<string, unknown>)?.data;
      return segmentsFromUnknown(list);
    } catch {
      return [];
    }
  }

  private async requestJson(pathname: string, retried = false): Promise<unknown> {
    const token = await this.session.getAccessToken();
    if (!token) {
      throw new AuthExpiredError();
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000)
      });
    } catch (err) {
      throw isTransportError(err) ? err : new Error(redactSecrets(String(err)));
    }
    if (res.status === 401 && !retried) {
      try {
        await this.session.refresh();
      } catch (err) {
        if (isTransportError(err) || isAuthExpiredError(err)) {
          throw err;
        }
        throw new AuthExpiredError();
      }
      return this.requestJson(pathname, true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthExpiredError();
    }
    if (!res.ok) {
      const err = new Error(`Plaud API HTTP ${res.status} for ${pathname.split("?")[0]}`);
      (err as { transient?: boolean }).transient = res.status >= 500 || res.status === 429;
      throw err;
    }
    return res.json();
  }
}
