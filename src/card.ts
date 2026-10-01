/**
 * Credit / debit card redaction for Plaud summaries and transcripts.
 *
 * Runs on raw Plaud text before anything leaves the Mini, next to SSN redaction.
 * Removes full card numbers (written or spoken, also when the transcription
 * dropped or added a digit), partial numbers ("ending in 4417", "Visa that
 * begins with 4111", "last four of the card"), the security code (CVV / CVC)
 * and the expiration date. Full numbers and 4-digit partials found anywhere in
 * a recording are removed everywhere in it.
 */

import { DIGIT_WORDS, isYearInDate, protectedRanges } from "./ssn.js";

export const CARD_NUMBER_REPLACEMENT = "[card number redacted]";
export const CARD_CODE_REPLACEMENT = "[card code redacted]";
export const CARD_EXPIRY_REPLACEMENT = "[card expiration redacted]";

const UNIT = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const UNIT_NZ = "(?:one|two|three|four|five|six|seven|eight|nine)";
const TEEN = "(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
const TENS = "(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const TOKEN = `(?:\\d+|(?:double|triple)[ -]${UNIT}|${TENS}(?:[ -]${UNIT_NZ})?|${TEEN}|${UNIT})`;
const SEP = "[ \\t,.\\-\\u2013\\u2014/]*";
/** A run of written or spoken digits on one line ("4111 1111", "forty one eleven", "double four"). */
const NUMBER_RUN = new RegExp(`(?<![\\w])${TOKEN}(?:${SEP}${TOKEN})*(?![\\w])`, "gi");

const TEEN_VALUES: Record<string, string> = {
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19"
};
const TENS_VALUES: Record<string, string> = {
  twenty: "2",
  thirty: "3",
  forty: "4",
  fifty: "5",
  sixty: "6",
  seventy: "7",
  eighty: "8",
  ninety: "9"
};

/** Words that put a number in card territory. */
const CARD_WORD = /\b(?:card|visa|master\s?card|amex|american\s+express|discover|debit|credit)\b/gi;
/** "ending in", "ends with", "begins in", "starting with" — a partial number follows. */
const PARTIAL_TRIGGER = /\b(?:end(?:s|ing|ed)?|begin(?:s|ning)?|start(?:s|ing)?)(?:\s+(?:in|with))?\b/gi;
/** "last four (digits) of the/your card" — the answer may land in the next utterance. */
const LAST_FOUR_TRIGGER = /\blast\s+(?:four|4)(?:\s+(?:digits|numbers))?(?=[^.?!\n]{0,40}\bcard\b)/gi;
/** A 4-digit run naming a card: "the 4417 card", "my 4417 Visa". */
const CARD_AFTER = /^[\s`'"“”‘’)]*(?:(?:visa|master\s?card|amex|credit|debit|signature|rewards)\s+)*(?:card|visa|master\s?card|amex)\b/i;
const CODE_TRIGGER = /\b(?:cvv2?|cvc2?|cid|security\s+code|three[- ]digit\s+code|(?:code|digits|numbers)\s+on\s+the\s+back)\b/gi;
const EXPIRY_TRIGGER = /\b(?:expiration(?:\s+date)?|expiry(?:\s+date)?|exp\.?(?:\s+date)?|expires?|expir(?:ed|ing)|valid\s+(?:thru|through))(?![\w])/gi;

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** "30 days", "500 dollars", "5 percent" — an amount, not part of a card. */
const UNIT_AFTER = /^\s*(?:%|percent|dollars?|bucks|cents?|days?|weeks?|months?|years?|hours?|minutes?)\b/i;
const ORDINAL_AFTER = /^(?:st|nd|rd|th)\b|^[ \t-]*(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\w+teenth|\w+tieth)\b/i;

/** Lookahead window after a trigger, long enough to cross into the next utterance. */
const WINDOW_CHARS = 320;
const CONTEXT_BEFORE = 200;
const CONTEXT_AFTER = 80;

type Kind = "number" | "code" | "expiry";

interface Run {
  start: number;
  end: number;
  digits: string;
}

interface Hit {
  start: number;
  end: number;
  kind: Kind;
  /** Value to remove everywhere in the recording (full numbers and 4-digit partials). */
  spread?: string;
}

const REPLACEMENT: Record<Kind, string> = {
  number: CARD_NUMBER_REPLACEMENT,
  code: CARD_CODE_REPLACEMENT,
  expiry: CARD_EXPIRY_REPLACEMENT
};

export function cardDigits(run: string): string {
  let out = "";
  const re = new RegExp(`\\d+|(double|triple)[ -](${UNIT})|(${TENS})(?:[ -](${UNIT_NZ}))?|${TEEN}|${UNIT}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(run))) {
    const word = m[0].toLowerCase();
    if (/^\d+$/.test(word)) {
      out += word;
    } else if (m[1]) {
      out += DIGIT_WORDS[m[2].toLowerCase()].repeat(m[1].toLowerCase() === "double" ? 2 : 3);
    } else if (m[3]) {
      out += TENS_VALUES[m[3].toLowerCase()] + (m[4] ? DIGIT_WORDS[m[4].toLowerCase()] : "0");
    } else {
      out += TEEN_VALUES[word] ?? DIGIT_WORDS[word];
    }
  }
  return out;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function numberRuns(text: string): Run[] {
  const guarded = protectedRanges(text);
  const runs: Run[] = [];
  NUMBER_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RUN.exec(text))) {
    const start = m.index;
    const end = start + m[0].replace(/[ \t,.\-–—/]+$/, "").length;
    if (guarded.some(([a, b]) => start < b && end > a)) {
      continue;
    }
    const digits = cardDigits(text.slice(start, end));
    if (digits) {
      runs.push({ start, end, digits });
    }
  }
  return runs;
}

function matchesOf(text: string, re: RegExp): Array<{ start: number; end: number }> {
  return [...text.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}

function hasCardContext(text: string, start: number, end: number): boolean {
  return new RegExp(CARD_WORD.source, "i").test(text.slice(Math.max(0, start - CONTEXT_BEFORE), end + CONTEXT_AFTER));
}

/** Written card shapes: 4-4-4-4 (or a truncated last group) and Amex 4-6-5. */
function looksLikeCardShape(raw: string): boolean {
  return /^\d{4}([ -])\d{4}\1\d{4}(?:\1\d{1,7})?$/.test(raw) || /^\d{4}([ -])\d{6}\1\d{5}$/.test(raw);
}

function isAmount(text: string, run: Run): boolean {
  return text[run.start - 1] === "$" || UNIT_AFTER.test(text.slice(run.end, run.end + 12));
}

function isFullNumber(digits: string): boolean {
  return digits.length >= 12 && digits.length <= 19;
}

function numberHit(run: Run): Hit {
  return { start: run.start, end: run.end, kind: "number", spread: run.digits };
}

/** A month/year expiration right after the trigger; never a full date with a day. */
function expiryAfter(text: string, at: number, runs: Run[]): Hit | undefined {
  const tail = text.slice(at, at + 120);
  const candidates: Hit[] = [];

  const written = /^[^\d\n]{0,40}?\b(?:0?[1-9]|1[0-2])\s?[/-]\s?(?:\d{4}|\d{2})\b(?!\s?[/-]\s?\d)/.exec(tail);
  if (written) {
    const lead = /^[^\d\n]*/.exec(written[0])![0].length;
    candidates.push({ start: at + lead, end: at + written[0].length, kind: "expiry" });
  }

  const month = new RegExp(`^[^\\n]{0,40}?\\b(${MONTH})\\.?,?(?:\\s+of)?\\s+`, "i").exec(tail);
  if (month) {
    const yearStart = at + month[0].length;
    const run = runs.find((r) => r.start === yearStart);
    if (run && (run.digits.length === 2 || run.digits.length === 4)) {
      const after = text.slice(run.end, run.end + 30);
      const hasDay = ORDINAL_AFTER.test(after) || /^\s*,?\s*(?:of\s+)?(?:\d|(?:twenty|nineteen|two thousand)\b)/i.test(after);
      if (!hasDay) {
        candidates.push({ start: at + month[0].search(new RegExp(`\\b${MONTH}`, "i")), end: run.end, kind: "expiry" });
      }
    }
  }

  const bare = runs.find((r) => r.start >= at && r.start <= at + 40);
  if (bare) {
    const d = bare.digits;
    const mm = d.length === 3 ? Number(d.slice(0, 1)) : Number(d.slice(0, 2));
    if ([3, 4, 6].includes(d.length) && mm >= 1 && mm <= 12 && !ORDINAL_AFTER.test(text.slice(bare.end, bare.end + 30))) {
      candidates.push({ start: bare.start, end: bare.end, kind: "expiry" });
    }
  }

  return candidates.sort((a, b) => a.start - b.start)[0];
}

/** Every card detail this one text points at by itself. */
function scan(text: string): Hit[] {
  const runs = numberRuns(text);
  const hits: Hit[] = [];

  for (const run of runs) {
    const raw = text.slice(run.start, run.end);
    if ((isFullNumber(run.digits) && run.digits.length >= 13 && luhn(run.digits)) || looksLikeCardShape(raw)) {
      hits.push(numberHit(run));
    }
  }

  for (const t of matchesOf(text, CARD_WORD)) {
    for (const run of runs) {
      if (run.start >= t.end && run.start <= t.end + WINDOW_CHARS && isFullNumber(run.digits)) {
        hits.push(numberHit(run));
      }
    }
  }

  for (const t of matchesOf(text, PARTIAL_TRIGGER)) {
    const run = runs.find((r) => r.start >= t.end && r.start <= t.end + 30);
    if (!run || run.digits.length < 2 || run.digits.length > 6 || isAmount(text, run) || !hasCardContext(text, t.start, t.end)) {
      continue;
    }
    if (!/^[\s,:;`'"“”‘’(]*(?:(?:in|with|um|uh|number|digits|is|the)\b[\s,:;`'"“”‘’(]*)*$/i.test(text.slice(t.end, run.start))) {
      continue;
    }
    hits.push({ start: run.start, end: run.end, kind: "number", spread: run.digits.length === 4 && !isYearInDate(text, run) ? run.digits : undefined });
  }

  // "this card is the 4417 card", "my 4417 Visa"
  for (const run of runs) {
    if (run.digits.length === 4 && !isYearInDate(text, run) && !isAmount(text, run) && CARD_AFTER.test(text.slice(run.end, run.end + 30))) {
      hits.push(numberHit(run));
    }
  }

  for (const t of matchesOf(text, LAST_FOUR_TRIGGER)) {
    const run = runs.find((r) => r.start >= t.end && r.start <= t.end + WINDOW_CHARS && r.digits.length === 4 && !isYearInDate(text, r));
    if (run) {
      hits.push(numberHit(run));
    }
  }

  for (const t of matchesOf(text, CODE_TRIGGER)) {
    const run = runs.find((r) => r.start >= t.end && r.start <= t.end + 160 && (r.digits.length === 3 || r.digits.length === 4) && !isAmount(text, r));
    if (run) {
      hits.push({ start: run.start, end: run.end, kind: "code" });
    }
  }

  for (const t of matchesOf(text, EXPIRY_TRIGGER)) {
    if (!hasCardContext(text, t.start, t.end)) {
      continue;
    }
    const hit = expiryAfter(text, t.end, runs);
    if (hit) {
      hits.push(hit);
    }
  }

  return hits;
}

/** Card values to remove everywhere in a recording: full numbers, their last four, and 4-digit partials. */
export function findCardDigits(texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const hit of scan(text)) {
      if (hit.spread) {
        found.add(hit.spread);
        if (isFullNumber(hit.spread)) {
          found.add(hit.spread.slice(-4));
        }
      }
    }
  }
  return found;
}

/** Replace every card detail in this text, plus any number run matching a value found elsewhere in the recording. */
export function redactCards(text: string, cardValues: Set<string>): { text: string; count: number } {
  const hits = scan(text);
  if (cardValues.size) {
    for (const run of numberRuns(text)) {
      const known =
        (cardValues.has(run.digits) && (run.digits.length !== 4 || !isYearInDate(text, run))) ||
        [...cardValues].some((d) => isFullNumber(d) && run.digits.includes(d));
      if (known) {
        hits.push(numberHit(run));
      }
    }
  }
  if (!hits.length) {
    return { text, count: 0 };
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const h of hits) {
    if (h.start < cursor) {
      continue;
    }
    out += text.slice(cursor, h.start) + REPLACEMENT[h.kind];
    cursor = h.end;
    count++;
  }
  out += text.slice(cursor);
  return { text: out, count };
}

/**
 * Redact card details across every text of one recording. Values found in one
 * text (e.g. the transcript) are also removed from the others (e.g. the summary).
 */
export function redactCardsAcross<T extends Record<string, string>>(texts: T): { texts: T; count: number } {
  const found = findCardDigits(Object.values(texts));
  let count = 0;
  const out = {} as Record<string, string>;
  for (const [key, value] of Object.entries(texts)) {
    const r = redactCards(value, found);
    out[key] = r.text;
    count += r.count;
  }
  return { texts: out as T, count };
}
