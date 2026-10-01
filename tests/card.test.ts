import { describe, expect, it } from "vitest";
import {
  CARD_CODE_REPLACEMENT,
  CARD_EXPIRY_REPLACEMENT,
  CARD_NUMBER_REPLACEMENT,
  cardDigits,
  findCardDigits,
  luhn,
  redactCardsAcross
} from "../src/card.js";
import { redactSsnAcross, SSN_REPLACEMENT } from "../src/ssn.js";

// All numbers here are synthetic (4111… is the public Visa test number).
const N = CARD_NUMBER_REPLACEMENT;
const C = CARD_CODE_REPLACEMENT;
const X = CARD_EXPIRY_REPLACEMENT;

describe("cardDigits / luhn", () => {
  it("reads written, spoken, doubled, teen and tens digits", () => {
    expect(cardDigits("4111 1111")).toBe("41111111");
    expect(cardDigits("four one one one")).toBe("4111");
    expect(cardDigits("forty one eleven")).toBe("4111");
    expect(cardDigits("oh eight twenty nine")).toBe("0829");
    expect(cardDigits("double four, one seven")).toBe("4417");
  });

  it("checks the Luhn digit", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });
});

describe("redactCardsAcross", () => {
  it("redacts a written number in the summary and its last four everywhere", () => {
    const summary = "He provided his full card number, 4111 1111 1111 1111, for the representative.";
    const transcript = ["Speaker 2 00:00:41", "Okay, got your Visa ending in 1111 pulled up now."].join("\n");
    const r = redactCardsAcross({ summary, transcript });
    expect(r.texts.summary).toBe(`He provided his full card number, ${N}, for the representative.`);
    expect(r.texts.transcript).toContain(`Visa ending in ${N} pulled up`);
    expect(r.texts.transcript).toContain("Speaker 2 00:00:41");
  });

  it("redacts a noisy spoken number in the next speaker's line and a truncated written copy", () => {
    const transcript = [
      "Speaker 2 00:00:30",
      "Um, do you have your Chase credit card number?",
      "Speaker 1 00:00:33",
      "Yes, it is four one one one one one one one one one one one one one one one one.",
      "Speaker 2 00:00:41",
      "Okay, got your Prime Visa ending one one pulled up now. Cash advance fee would be five percent or minimum of ten dollars."
    ].join("\n");
    const summary = "- The customer's full credit card number is 4111 1111 1111 1.\n- The current rate is 29.99% variable.";
    const r = redactCardsAcross({ transcript, summary });
    expect(r.texts.transcript).toContain(`Speaker 1 00:00:33\nYes, it is ${N}.`);
    expect(r.texts.transcript).toContain(`Prime Visa ending ${N} pulled up now. Cash advance fee would be five percent or minimum of ten dollars.`);
    expect(r.texts.summary).toBe(`- The customer's full credit card number is ${N}.\n- The current rate is 29.99% variable.`);
  });

  it("treats 'last four of the card' as the card, not the SSN", () => {
    const transcript = [
      "Speaker 2 00:01:00",
      "Thank you, Mr. Coates. The last four numbers of the card that you're calling about.",
      "Speaker 1 00:01:04",
      "Um, it's not the one ending in four four one seven.",
      "Speaker 2 00:01:20",
      "Okay, so this card is the four four one seven card. Visa signature card that begins in four one one one.",
      "Speaker 1 00:01:30",
      "And the other one, the 5522 Visa?"
    ].join("\n");
    const summary = "He holds two cards, one ending in `4417` and another one.";
    const cards = redactCardsAcross({ transcript, summary });
    const both = redactSsnAcross(cards.texts);
    expect(both.count).toBe(0);
    expect(both.texts.transcript).toContain(`it's not the one ending in ${N}.`);
    expect(both.texts.transcript).toContain(`this card is the ${N} card. Visa signature card that begins in ${N}.`);
    expect(both.texts.transcript).toContain(`the other one, the ${N} Visa?`);
    expect(both.texts.summary).toBe(`He holds two cards, one ending in \`${N}\` and another one.`);
    expect(both.texts.transcript).not.toContain(SSN_REPLACEMENT);
  });

  it("redacts security codes", () => {
    const transcript = "And the security code on the back? Uh, seven three seven. Thanks.";
    const summary = "Card verified (CVV 737).";
    const r = redactCardsAcross({ transcript, summary });
    expect(r.texts.transcript).toBe(`And the security code on the back? Uh, ${C}. Thanks.`);
    expect(r.texts.summary).toBe(`Card verified (CVV ${C}).`);
  });

  it("redacts expiration dates in every common form", () => {
    expect(redactCardsAcross({ t: "What's the expiration date on the card? Oh eight twenty nine." }).texts.t).toBe(
      `What's the expiration date on the card? ${X}.`
    );
    expect(redactCardsAcross({ t: "Visa, exp 08/29, billing zip on file." }).texts.t).toBe(`Visa, exp ${X}, billing zip on file.`);
    expect(redactCardsAcross({ t: "The new debit card expires August 2029." }).texts.t).toBe(`The new debit card expires ${X}.`);
    expect(redactCardsAcross({ t: "Card expiration: 8/2029" }).texts.t).toBe(`Card expiration: ${X}`);
  });

  it("redacts a Luhn-valid number with no context at all", () => {
    expect(redactCardsAcross({ t: "Note to self 4111111111111111 for later." }).texts.t).toBe(`Note to self ${N} for later.`);
  });

  it("leaves promotions, fees, rates, phone numbers, SSN talk and timestamps alone", () => {
    const transcript = [
      "Speaker 1 00:12:05",
      "Looks like that will expire July twenty first of twenty twenty seven. With your payment on the card, it'll be sixty five dollars.",
      "Speaker 2 01:02:03",
      "Your credit card rate is 29.99 percent; the fee is 5 percent or a minimum of 10 dollars. The offer ends in 30 days.",
      "Speaker 1 01:02:10",
      "Call the card line at 605 555 0100. What's your social security number? Credit limit is 4500 dollars. Back in 2019 cards were easier."
    ].join("\n");
    const summary =
      "- Current monthly payment with card: $65.\n- Amber is on a promotion with one year remaining, expiring July 21, 2027.\n- The promotion expires on July 21, 2027.";
    const r = redactCardsAcross({ transcript, summary });
    expect(r.count).toBe(0);
    expect(r.texts).toEqual({ transcript, summary });
    expect(findCardDigits([transcript, summary]).size).toBe(0);
  });
});
