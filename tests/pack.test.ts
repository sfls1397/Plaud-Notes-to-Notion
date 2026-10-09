import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/constants.js";
import { looksLikeSecret } from "../src/redact.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("package version", () => {
  it("is 1.1.0 in package.json, the lockfile, and PACKAGE_VERSION", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      version: string;
      packages: { "": { version: string } };
    };
    expect(pkg.version).toBe("1.1.0");
    expect(lock.version).toBe("1.1.0");
    expect(lock.packages[""].version).toBe("1.1.0");
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe("npm pack", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("does not include secrets, env files, or machine-local config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaud-pack-"));
    tmpDirs.push(dir);
    execFileSync("npm", ["pack", "--pack-destination", dir], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const tgz = fs.readdirSync(dir).find((name) => name.endsWith(".tgz"));
    expect(tgz).toBe(`plaud-notes-to-notion-${PACKAGE_VERSION}.tgz`);
    execFileSync("tar", ["-xzf", tgz!], { cwd: dir });
    const packedRoot = path.join(dir, "package");
    const files = walkFiles(packedRoot).map((full) => path.relative(packedRoot, full).split(path.sep).join("/"));

    const forbidden = [
      /^\.env(?:$|\.)/,
      /(?:^|\/)\.env(?:$|\.)/,
      /(?:^|\/)secrets\//,
      /(?:^|\/)\.plaud-notes-to-notion\//,
      /(?:^|\/)config\.json$/,
      /\.log$/,
      /\.pem$/,
      /\.key$/,
      /^tests\//,
      /^src\//,
      /^\.git\//
    ];
    for (const file of files) {
      for (const re of forbidden) {
        expect(file, file).not.toMatch(re);
      }
    }

    expect(files).toEqual(expect.arrayContaining(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]));
    expect(files.some((file) => file.startsWith("bin/"))).toBe(true);
    expect(files.some((file) => file.startsWith("dist/") && file.endsWith(".js"))).toBe(true);
    expect(files.some((file) => file.startsWith("examples/"))).toBe(true);

    const packedPkg = JSON.parse(fs.readFileSync(path.join(packedRoot, "package.json"), "utf8")) as { version: string };
    expect(packedPkg.version).toBe("1.1.0");

    const machinePath = /(?:^|[\s"'`])(?:\/Users\/|\/home\/[^/\s]+\/|\\\\Users\\)|Macmini\.lan/i;
    for (const file of files) {
      const text = fs.readFileSync(path.join(packedRoot, file), "utf8");
      expect(looksLikeSecret(text), file).toBe(false);
      expect(text, file).not.toMatch(machinePath);
    }
  });
});
