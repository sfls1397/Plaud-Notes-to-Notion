import { NOTION_TEXT_CHUNK, NOTION_VERSION } from "./constants.js";
import { redactSecrets } from "./redact.js";
import { findCardDigits, redactCards } from "./card.js";
import { findSsnDigits, redactDigits } from "./ssn.js";

/**
 * One-off cleanup for rows written before a redaction existed (the Zap era for
 * SSNs, before 2026-10-01 for cards). Scans a data source, pairs rows by
 * Recorded minute (a value spoken in the transcript is also removed from the
 * summary), and rewrites only the affected rich-text runs in place — block
 * types, nesting and formatting are kept. Dry run unless `apply` is true.
 */
type Json = Record<string, unknown>;

interface TextBlock {
  id: string;
  type: string;
  rich: Array<{ plain_text: string; type: string; text?: { content: string; link: unknown }; annotations: Json; href?: unknown }>;
}

export interface ScrubResult {
  rowsScanned: number;
  rowsAffected: Array<{ title: string; type: string; ssn: number; card: number }>;
  blocksUpdated: number;
}

/** Consecutive plain-text runs with identical formatting and link; other runs stand alone. */
function sameFormatGroups(rich: TextBlock["rich"]): Array<TextBlock["rich"]> {
  const key = (r: TextBlock["rich"][number]) => (r.type === "text" ? JSON.stringify([r.annotations, r.text?.link ?? null]) : undefined);
  const groups: Array<TextBlock["rich"]> = [];
  for (const r of rich) {
    const last = groups[groups.length - 1];
    if (last && key(r) !== undefined && key(r) === key(last[0])) {
      last.push(r);
    } else {
      groups.push([r]);
    }
  }
  return groups;
}

export async function scrubSensitive(options: {
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
    const texts = loaded.map((l) => l.blocks.map((b) => b.rich.map((r) => r.plain_text).join("")).join("\n"));
    const cardFound = findCardDigits(texts);
    // SSN values are looked for after card details are gone, exactly like ingest.
    const ssnFound = findSsnDigits(texts.map((t) => redactCards(t, cardFound).text));
    for (const { page, blocks } of loaded) {
      let ssn = 0;
      let card = 0;
      for (const block of blocks) {
        let changed = false;
        // Adjacent runs with the same formatting are redacted as one string, so a
        // trigger and its number split across runs are still caught. The Zap wrote
        // whole transcripts as one run of up to ~11k chars; the API only accepts
        // ≤2000 per run on write, so rewritten runs are re-split (same formatting).
        const rich: Json[] = [];
        for (const group of sameFormatGroups(block.rich)) {
          if (group[0].type !== "text") {
            rich.push(...(group as unknown as Json[]));
            continue;
          }
          const plain = group.map((r) => r.plain_text).join("");
          const c = redactCards(plain, cardFound);
          const n = redactDigits(c.text, ssnFound);
          if (!c.count && !n.count) {
            rich.push(...(group as unknown as Json[]));
            continue;
          }
          card += c.count;
          ssn += n.count;
          changed = true;
          for (let i = 0; i < n.text.length; i += NOTION_TEXT_CHUNK) {
            rich.push({
              type: "text",
              text: { content: n.text.slice(i, i + NOTION_TEXT_CHUNK), link: group[0].text?.link ?? null },
              annotations: group[0].annotations
            });
          }
        }
        if (changed) {
          result.blocksUpdated++;
          if (options.apply) {
            await api("PATCH", `/blocks/${block.id}`, { [block.type]: { rich_text: rich } });
          }
        }
      }
      if (ssn || card) {
        const props = page.properties as Record<string, Json>;
        const title = ((props.Meeting?.title || []) as Array<{ plain_text: string }>).map((t) => t.plain_text).join("");
        const type = ((props.Type?.multi_select || []) as Array<{ name: string }>).map((t) => t.name).join(",");
        result.rowsAffected.push({ title, type, ssn, card });
        options.log(`${options.apply ? "scrubbed" : "DRY RUN would scrub"} ${ssn} SSN + ${card} card mention(s) in ${type} "${title}"`);
      }
    }
  }
  return result;
}
