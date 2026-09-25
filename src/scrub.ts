import { NOTION_VERSION } from "./constants.js";
import { redactSecrets } from "./redact.js";
import { findSsnDigits, redactDigits } from "./ssn.js";

/**
 * One-off cleanup for rows written before redaction existed (the Zap era).
 * Scans a data source, pairs rows by Recorded minute (a value spoken in the
 * transcript is also removed from the summary), and rewrites only the affected
 * rich-text runs in place — block types, nesting and formatting are kept.
 * Dry run unless `apply` is true.
 */
type Json = Record<string, unknown>;

interface TextBlock {
  id: string;
  type: string;
  rich: Array<{ plain_text: string; type: string; text?: { content: string; link: unknown }; annotations: Json; href?: unknown }>;
}

export interface ScrubResult {
  rowsScanned: number;
  rowsAffected: Array<{ title: string; type: string; mentions: number }>;
  blocksUpdated: number;
}

export async function scrubSsn(options: {
  token: string;
  dataSourceId: string;
  apply: boolean;
  log: (m: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<ScrubResult> {
  const f = options.fetchImpl || fetch;
  const api = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const res = await f(`https://api.notion.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${options.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      throw new Error(redactSecrets(`Notion HTTP ${res.status}: ${String(json.message || "")}`));
    }
    return json;
  };

  const pages: Json[] = [];
  let cursor: string | undefined;
  do {
    const j = await api("POST", `/data_sources/${options.dataSourceId}/query`, { page_size: 100, start_cursor: cursor });
    pages.push(...((j.results || []) as Json[]));
    cursor = j.has_more ? String(j.next_cursor) : undefined;
  } while (cursor);

  const blocksOf = async (id: string): Promise<TextBlock[]> => {
    const out: TextBlock[] = [];
    let c: string | undefined;
    do {
      const j = await api("GET", `/blocks/${id}/children?page_size=100${c ? `&start_cursor=${c}` : ""}`);
      for (const b of (j.results || []) as Json[]) {
        const type = String(b.type);
        const rich = ((b[type] as Json | undefined)?.rich_text || []) as TextBlock["rich"];
        if (rich.length) {
          out.push({ id: String(b.id), type, rich });
        }
        if (b.has_children) {
          out.push(...(await blocksOf(String(b.id))));
        }
      }
      c = j.has_more ? String(j.next_cursor) : undefined;
    } while (c);
    return out;
  };

  const groups = new Map<string, Json[]>();
  for (const p of pages) {
    const rec = ((p.properties as Json)?.Recorded as Json | undefined)?.date as { start?: string } | undefined;
    const key = rec?.start ? rec.start.slice(0, 16) : String(p.id);
    groups.set(key, [...(groups.get(key) || []), p]);
  }

  const result: ScrubResult = { rowsScanned: pages.length, rowsAffected: [], blocksUpdated: 0 };
  for (const rows of groups.values()) {
    const loaded = await Promise.all(rows.map(async (p) => ({ page: p, blocks: await blocksOf(String(p.id)) })));
    const found = findSsnDigits(loaded.map((l) => l.blocks.map((b) => b.rich.map((r) => r.plain_text).join("")).join("\n")));
    if (!found.size) {
      continue;
    }
    for (const { page, blocks } of loaded) {
      let mentions = 0;
      for (const block of blocks) {
        let changed = false;
        const rich = block.rich.map((r) => {
          const red = redactDigits(r.plain_text, found);
          if (!red.count || r.type !== "text") {
            return r;
          }
          mentions += red.count;
          changed = true;
          return { type: "text", text: { content: red.text, link: r.text?.link ?? null }, annotations: r.annotations };
        });
        if (changed) {
          result.blocksUpdated++;
          if (options.apply) {
            await api("PATCH", `/blocks/${block.id}`, { [block.type]: { rich_text: rich } });
          }
        }
      }
      if (mentions) {
        const props = page.properties as Record<string, Json>;
        const title = ((props.Meeting?.title || []) as Array<{ plain_text: string }>).map((t) => t.plain_text).join("");
        const type = ((props.Type?.multi_select || []) as Array<{ name: string }>).map((t) => t.name).join(",");
        result.rowsAffected.push({ title, type, mentions });
        options.log(`${options.apply ? "scrubbed" : "DRY RUN would scrub"} ${mentions} SSN mention(s) in ${type} "${title}"`);
      }
    }
  }
  return result;
}
