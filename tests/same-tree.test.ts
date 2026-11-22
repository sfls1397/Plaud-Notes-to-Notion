import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tool(args: string[]) {
  const result = spawnSync(process.execPath, [path.resolve(".lint/same-tree.mjs"), path.resolve("node_modules"), ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr, stdout: result.stdout };
}

function files(...sources: string[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "same-tree-"));
  temps.push(dir);
  return sources.map((source, i) => {
    const file = path.join(dir, `f${i}.ts`);
    fs.writeFileSync(file, source);
    return file;
  });
}

const COMMENTED = [
  "/** the module */",
  "import { a } from './a';",
  "// why",
  "const url = 'http://x//y'; // trailing",
  "const pattern = /a\\/\\/b/;",
  "function f(): number {",
  "  /* block",
  "     comment */",
  "  return a + 1;",
  "}",
  "try { f(); } catch { /* nothing to do */ }",
  "describe('first title', () => { it('second title', () => {}); });",
  ""
].join("\n");

const CLEAN = [
  "import { a } from './a';",
  "const url = 'http://x//y';",
  "const pattern = /a\\/\\/b/;",
  "function f(): number {",
  "  return a + 1;",
  "}",
  "try { f(); } catch { }",
  "describe('first title', () => { it('second title', () => {}); });",
  ""
].join("\n");

describe("same-tree strip", () => {
  it("removes every comment and keeps `//` inside strings and regular expressions", () => {
    const [file] = files(COMMENTED);
    const result = tool(["strip", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(CLEAN.replace("catch { }", "catch {  }"));
  });
});

describe("same-tree compare", () => {
  const same = (before: string, after: string) => {
    const [a, b] = files(before, after);
    return tool(["compare", a, b]);
  };

  it("says the tree is the same when only comments and whitespace differ", () => {
    expect(same(COMMENTED, CLEAN)).toMatchObject({ status: 0, stdout: "same tree\n" });
  });

  it("ignores test titles and nothing else a string can hold", () => {
    expect(same("it('old title', () => { f('a'); });", "it('new title', () => { f('a'); });").status).toBe(0);
    expect(same("it('t', () => { f('a'); });", "it('t', () => { f('b'); });").status).toBe(1);
    expect(same("describe.only('old', () => {});", "describe.only('new', () => {});").status).toBe(0);
    expect(same("g('old', () => {});", "g('new', () => {});").status).toBe(1);
  });

  it.each([
    ["a renamed identifier", "const a = b;", "const a = c;"],
    ["a changed number", "const a = 1;", "const a = 2;"],
    ["a changed operator", "const a = b + c;", "const a = b - c;"],
    ["a changed prefix operator", "const a = !b;", "const a = -b;"],
    ["const turned into let", "const a = 1;", "let a = 1;"],
    ["a dropped statement", "f(); g();", "f();"],
    ["a changed string", "f('x');", "f('y');"],
    ["a changed template", "f(`x${a}`);", "f(`y${a}`);"],
    ["a changed regular expression", "const r = /a/g;", "const r = /a/i;"],
    ["an emptied block", "if (a) { f(); }", "if (a) { }"],
    ["import type turned into import", "import type { A } from './a';", "import { A } from './a';"],
    ["export type turned into export", "export type { A } from './a';", "export { A } from './a';"],
    ["an inline type specifier dropped", "import { type A, b } from './a';", "import { A, b } from './a';"],
    ["import type require turned into import require", "import type a = require('a');", "import a = require('a');"],
    ["export default turned into export equals", "export default foo;", "export = foo;"],
    ["namespace turned into module", "namespace N { export const x = 1; }", "module N { export const x = 1; }"]
  ])("fails on %s", (_name, before, after) => {
    const result = same(before, after);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^different tree: /);
  });

  it("never prints the text of an empty block that holds a comment", () => {
    const result = same("if (a) { /* leaked comment words */ }", "if (a) { f(); }");
    expect(result.status).toBe(1);
    expect(result.out).not.toContain("leaked");
    expect(result.out).not.toContain("comment");
  });

  it("never prints a name or literal it finds different", () => {
    const result = same("const secretName = 'secretValue';", "const secretName = 'otherValue';");
    expect(result.status).toBe(1);
    expect(result.out).not.toContain("secretValue");
    expect(result.out).not.toContain("secretName");
  });

  it("refuses a file that does not parse", () => {
    const result = same("const = ;", "const a = 1;");
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("does not parse");
  });
});
