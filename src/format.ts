import type { PlaudSegment } from "./plaud/client.js";

export function cleanSummaryMarkdown(markdown: string): string {
  let t = markdown.replace(/\r\n?/g, "\n");
  t = t.split("PLAUD NOTE").join("");
  t = smartQuotes(t);
  t = t.replace(/!\[[^\]]*\]\([ \t]*\n?[ \t]*permanent\/[^)]*\)\n*/g, "");
  t = t.replace(/\n-{3,}\n/g, "\n");
  t = t.replace(/\n[ \t]*\n+/g, "\n");
  t = t.replace(/^> \*\*(.+?):\*\*[ \t]*(.*)$/gm, (_m, label: string, rest: string) =>
    rest && rest.trim().length > 0 ? `**${label}:**\n> ${rest}` : `**${label}:**`
  );
  return mergeQuoteRuns(t.trim());
}

export function mergeQuoteRuns(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^>/.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const text: string[] = [];
    const children: string[] = [];
    while (i < lines.length && /^>/.test(lines[i])) {
      const body = lines[i].replace(/^>[ \t]?/, "");
      if (children.length || (text.length && /^(?:\d+\.|[-*+])\s+/.test(body))) {
        children.push(`\t${body}`);
      } else {
        text.push(body);
      }
      i++;
    }
    out.push(`> ${text.join("<br>")}`, ...children);
  }
  return out.join("\n");
}

export function smartQuotes(text: string): string {
  return text.replace(/(^|[\s(\[{—–-])"/gm, "$1“").replace(/"/g, "”");
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatTranscript(segments: PlaudSegment[]): string {
  return segments.map((s) => `${s.speaker} ${formatOffset(s.startMs)}\n${s.text}`).join("\n");
}

export function recordedMinute(startAt: Date): string {
  const d = new Date(startAt.getTime());
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

export function meetingTitle(plaudName: string): string {
  const t = plaudName.replace(/^\d{2}-\d{2}\s+/, "").trim();
  return t || "Untitled recording";
}

export function cleanParticipants(names: string[], owner: string): string[] {
  const ownerLc = owner.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/,/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
    const lc = name.toLowerCase();
    if (!name || /^speaker\s*\d*$/i.test(name) || /^unknown/i.test(name)) {
      continue;
    }
    if (lc === ownerLc) {
      continue;
    }
    if (!seen.has(lc)) {
      seen.add(lc);
      out.push(name);
    }
  }
  return out;
}

export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 300);
}
