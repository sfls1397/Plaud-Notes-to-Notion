/**
 * Social Security number redaction for Plaud summaries and transcripts.
 *
 * Runs on raw Plaud text before anything leaves the Mini (OpenAI or Notion).
 * Handles written digits ("4417", "523-81-4417") and spoken digits
 * ("zero zero two three", "double oh two three"), including answers that land
 * in the next speaker's utterance after "last four of your social?".
 */

export const SSN_REPLACEMENT = "[SSN redacted]";

export const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9"
};

const WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const TOKEN = `(?:\\d+|(?:double|triple)[ -]${WORD}|${WORD})`;
const SEP = "[ \\t,.\\-\\u2013\\u2014/]*";
/** A run of written or spoken digits on one line. */
const NUMBER_RUN = new RegExp(`(?<![\\w])${TOKEN}(?:${SEP}${TOKEN})*(?![\\w])`, "gi");

/**
 * Strong triggers name the SSN outright; weak triggers ("social", "last four")
 * need a following 4- or 9-digit number and skip year-shaped values.
 */
const STRONG_TRIGGER = /\b(?:social[ -]security(?:[ -](?:number|no\.?|#))?|s\.?\s?s\.?\s?n\.?|last\s+(?:four|4)(?:\s+digits)?\s+of\s+(?:(?:my|your|his|her|the)\s+)?(?:social|ss|ssn))\b/gi;
const WEAK_TRIGGER = /\b(?:social(?!\s+(?:media|work|worker|workers|club|event|events|network|networks|skills|life|anxiety|studies|circle|hour|security))|last\s+(?:four|4)(?![^.?!\n]{0,40}\bcard\b)(?:\s+digits)?)\b/gi;

/** Lookahead window after a trigger, long enough to cross into the next utterance. */
const WINDOW_CHARS = 320;

/** Plaud transcript header lines (`Speaker 1 00:01:05`) and bare timestamps are never SSNs. */
const PROTECTED = /^[^\n]*\b\d{1,2}:\d{2}:\d{2}[ \t]*$|\b\d{1,2}:\d{2}(?::\d{2})?\b/gm;

export interface SsnRedaction {
  text: string;
  count: number;
}

export function spokenDigits(run: string): string {
  let out = "";
  const re = new RegExp(`\\d+|(double|triple)[ -](${WORD})|${WORD}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(run))) {
    if (/^\d+$/.test(m[0])) {
      out += m[0];
    } else if (m[1]) {
      const d = DIGIT_WORDS[m[2].toLowerCase()];
      out += m[1].toLowerCase() === "double" ? d.repeat(2) : d.repeat(3);
    } else {
      out += DIGIT_WORDS[m[0].toLowerCase()];
    }
  }
  return out;
}

interface Run {
  start: number;
  end: number;
  digits: string;
}

export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  PROTECTED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED.exec(text))) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) {
      PROTECTED.lastIndex++;
    }
  }
  return ranges;
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
    const digits = spokenDigits(m[0]);
    if (digits) {
      runs.push({ start, end, digits });
    }
  }
  return runs;
}

export function looksLikeYear(digits: string): boolean {
  return digits.length === 4 && /^(?:19|20)\d\d$/.test(digits);
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** "January 1st, 1990", "August 10, 1984", "born in 1984", "10/08/1984" — a year inside a date, not an SSN. */
const DATE_BEFORE = new RegExp(
  `(?:\\b${MONTH}\\.?\\s+\\w{1,9}(?:st|nd|rd|th)?,?\\s*|\\b(?:born|birth|birthday|year|dob)\\b[^.?!\\n]{0,30}|\\d{1,2}[/-]\\d{1,2}[/-])$`,
  "i"
);

export function isYearInDate(text: string, run: { start: number; digits: string }): boolean {
  return looksLikeYear(run.digits) && DATE_BEFORE.test(text.slice(Math.max(0, run.start - 40), run.start));
}

function triggerEnds(text: string, re: RegExp): number[] {
  const ends: number[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ends.push(m.index + m[0].length);
  }
  return ends;
}

/** Digits of every SSN-shaped value the triggers point at, across all given texts. */
export function findSsnDigits(texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    const runs = numberRuns(text);
    for (const m of text.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) {
      found.add(m[0].replace(/-/g, ""));
    }
    const scan = (ends: number[], strong: boolean) => {
      for (const end of ends) {
        const hit = runs.find(
          (r) =>
            r.start >= end &&
            r.start <= end + WINDOW_CHARS &&
            (r.digits.length === 4 || r.digits.length === 9) &&
            !isYearInDate(text, r) &&
            (strong || !looksLikeYear(r.digits))
        );
        if (hit) {
          found.add(hit.digits);
        }
      }
    };
    scan(triggerEnds(text, STRONG_TRIGGER), true);
    scan(triggerEnds(text, WEAK_TRIGGER), false);
  }
  // A full SSN also exposes its last four.
  for (const d of [...found]) {
    if (d.length === 9) {
      found.add(d.slice(5));
    }
  }
  return found;
}

/** Replace every number run whose digits match a found SSN value (or contain a full one). */
export function redactDigits(text: string, ssnDigits: Set<string>): SsnRedaction {
  if (ssnDigits.size === 0) {
    return { text, count: 0 };
  }
  const runs = numberRuns(text).filter((r) => {
    if (ssnDigits.has(r.digits)) {
      return true;
    }
    return [...ssnDigits].some((d) => d.length === 9 && r.digits.includes(d));
  });
  let out = "";
  let cursor = 0;
  for (const r of runs) {
    out += text.slice(cursor, r.start) + SSN_REPLACEMENT;
    cursor = r.end;
  }
  out += text.slice(cursor);
  return { text: out, count: runs.length };
}

/**
 * Redact SSNs across every text of one recording. Values found in one text
 * (e.g. the transcript) are also removed from the others (e.g. the summary).
 */
export function redactSsnAcross<T extends Record<string, string>>(texts: T): { texts: T; count: number } {
  const found = findSsnDigits(Object.values(texts));
  let count = 0;
  const out = {} as Record<string, string>;
  for (const [key, value] of Object.entries(texts)) {
    const r = redactDigits(value, found);
    out[key] = r.text;
    count += r.count;
  }
  return { texts: out as T, count };
}
