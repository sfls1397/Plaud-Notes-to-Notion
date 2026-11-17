import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("environment secret redaction", () => {
  it.each(["NOTION_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])(
    "does not repeatedly scan overlapping %s suffixes",
    (name) => {
      const input = `${name}_`.repeat(22000);
      const started = performance.now();
      expect(redactSecrets(input)).toBe(input);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  );

  it.each(["NOTION_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])(
    "keeps redacting %s assignments without limiting profile length",
    (name) => {
      for (const suffix of ["", "_TEAM_1", `_${"A".repeat(64)}`, `_${"A".repeat(256)}`]) {
        for (const separator of ["=", ": ", " \t= "])
          expect(redactSecrets(`${name}${suffix}${separator}syntheticvalue`)).toBe(`${name}${suffix}${separator}[REDACTED]`);
      }
      expect(redactSecrets(`${name.toLowerCase()}_team=syntheticvalue`)).toBe(`${name.toLowerCase()}_team=[REDACTED]`);
      const malformed = `${name}_`.repeat(22000);
      expect(redactSecrets(`${malformed}\n${name}_TEAM=syntheticvalue`)).toBe(`${malformed}\n${name}_TEAM=[REDACTED]`);
    }
  );
});
