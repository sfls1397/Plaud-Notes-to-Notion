import { describe, expect, it } from "vitest";
import { findSsnDigits, redactSsnAcross, spokenDigits, SSN_REPLACEMENT } from "../src/ssn.js";

// All numbers here are synthetic.
const R = SSN_REPLACEMENT;

describe("spokenDigits", () => {
  it("reads written, spoken and doubled digits", () => {
    expect(spokenDigits("4417")).toBe("4417");
    expect(spokenDigits("four four one seven")).toBe("4417");
    expect(spokenDigits("double four, one seven")).toBe("4417");
    expect(spokenDigits("oh oh nine one")).toBe("0091");
  });
});

describe("redactSsnAcross", () => {
  it("redacts last four in a Plaud summary (written digits, curly quotes)", () => {
    const summary =
      "After identity verification (last four digits of SSN: 4417; date of birth: March 3, 1990).\n" +
      "- The customer provided identity details: last four of SSN “4417,” DOB “March third.”";
    const r = redactSsnAcross({ summary });
    expect(r.count).toBe(2);
    expect(r.texts.summary).not.toContain("4417");
    expect(r.texts.summary).toContain(`SSN: ${R}; date of birth: March 3, 1990`);
  });

  it("redacts a spoken answer in the next speaker's utterance, skipping the timestamp header", () => {
    const transcript = [
      "Speaker 2 00:00:41",
      "Are you calling about yourself? Yes. What are the last four digits of your social security number?",
      "Speaker 1 00:00:47",
      "Four four one seven. Please provide your date of birth.",
      "Speaker 2 00:00:52",
      "Thank you. Here's what I heard. Your last four of social is four four one seven, and your date of birth is March third, nineteen ninety."
    ].join("\n");
    const r = redactSsnAcross({ transcript });
    expect(r.count).toBe(2);
    expect(r.texts.transcript).toContain(`Speaker 1 00:00:47\n${R}. Please provide`);
    expect(r.texts.transcript).toContain(`social is ${R}, and your date of birth is March third, nineteen ninety.`);
    expect(r.texts.transcript).toContain("Speaker 2 00:00:41");
  });

  it("redacts a full spoken SSN and its last four everywhere in the recording", () => {
    const transcript = [
      "Speaker 2 00:03:10",
      "Can I give you something else? I can look it up by your social.",
      "Speaker 1 00:03:14",
      "Yeah, it's um, five two three, eight one, four four one seven.",
      "Speaker 2 00:03:20",
      "Thanks. So that's the account ending 4417."
    ].join("\n");
    const summary = "Caller verified with the number ending 4417.";
    const r = redactSsnAcross({ transcript, summary });
    expect(r.texts.transcript).toContain(`Yeah, it's um, ${R}.`);
    expect(r.texts.transcript).toContain(`account ending ${R}.`);
    expect(r.texts.summary).toBe(`Caller verified with the number ending ${R}.`);
  });

  it("always redacts dashed SSNs", () => {
    const r = redactSsnAcross({ summary: "Member ID confirmed as 523-81-4417 on file." });
    expect(r.texts.summary).toBe(`Member ID confirmed as ${R} on file.`);
  });

  it("leaves ordinary numbers, years, timestamps and speaker headers alone", () => {
    const transcript = [
      "Speaker 12 00:00:23",
      "Our social media budget for 2026 is 5000 dollars.",
      "Speaker 3 01:02:03",
      "I was born in nineteen eighty four. The social hour starts at 1900 hours.",
      "Speaker 1 00:10:00",
      "Call me at 605 555 0100 about the social event."
    ].join("\n");
    const r = redactSsnAcross({ transcript });
    expect(r.count).toBe(0);
    expect(r.texts.transcript).toBe(transcript);
  });

  it("weak trigger skips year-shaped numbers but strong trigger does not", () => {
    expect(findSsnDigits(["What's your social? It is, uh, 2019 I think we met."]).size).toBe(0);
    expect([...findSsnDigits(["last four of my social security number are 1984"])]).toEqual(["1984"]);
  });

  it("does nothing when there is nothing to find", () => {
    const r = redactSsnAcross({ summary: "## Core Synopsis\nNothing sensitive here.", transcript: "" });
    expect(r.count).toBe(0);
  });
});
