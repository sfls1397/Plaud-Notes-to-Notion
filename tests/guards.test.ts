import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobLock } from "../src/lock.js";
import { HttpNotionStore, NotionError } from "../src/notion.js";
import { runOAuthCallback } from "../src/plaud/callback.js";
import { KEYCHAIN_WRITE_FAILED, KeychainSecretStore } from "../src/secrets.js";
import { scrubSensitive } from "../src/scrub.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guards-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("bin entry", () => {
  it("always calls main, so the npm bin symlink can never exit 0 with nothing done", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "bin"));
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, "dist/cli.js"), 'export async function main() { process.stdout.write("ran"); return 7; }\n');
    fs.copyFileSync(path.resolve("bin/plaud-notes-to-notion.js"), path.join(dir, "bin/plaud-notes-to-notion.js"));
    fs.mkdirSync(path.join(dir, "links"));
    const link = path.join(dir, "links/plaud-notes-to-notion");
    fs.symlinkSync(path.join(dir, "bin/plaud-notes-to-notion.js"), link);
    const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
    expect(result.stdout).toBe("ran");
    expect(result.status).toBe(7);
  });
});

const SCHEMA = {
  properties: {
    Meeting: { type: "title" },
    Recorded: { type: "date" },
    Type: { type: "multi_select" },
    Participants: { type: "multi_select", multi_select: { options: [] } }
  }
};

function notionWith(respond: (method: string, url: string) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; url: string }> = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string, init: { method: string }) => {
    calls.push({ method: init.method, url: String(url) });
    const { status, body } = respond(init.method, String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const store = new HttpNotionStore({
    token: "token",
    dataSourceId: "ds",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    }
  });
  return { store, calls, sleeps };
}

const ROW = { title: "T", recorded: "2026-09-26T14:50:00.000Z", type: "Transcript" as const, participants: [] };

describe("HttpNotionStore", () => {
  it("never retries a create on a 502: a 5xx can hide a create that succeeded, so a retry would write the row twice", async () => {
    const { store, calls, sleeps } = notionWith((method, url) =>
      method === "POST" && url.endsWith("/pages") ? { status: 502, body: {} } : { status: 200, body: SCHEMA }
    );
    await expect(store.createTranscript(ROW, "hello")).rejects.toBeInstanceOf(NotionError);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never retries an append on a 502, for the same reason as a create", async () => {
    const { store, calls, sleeps } = notionWith((method, url) => {
      if (method === "PATCH" && url.includes("/children")) return { status: 502, body: {} };
      if (method === "POST" && url.endsWith("/pages")) return { status: 200, body: { id: "page-1" } };
      return { status: 200, body: SCHEMA };
    });
    const long = "x".repeat(2000 * 100 * 101);
    await expect(store.createTranscript(ROW, long)).rejects.toBeInstanceOf(NotionError);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("still retries a read on a 502, since a read changes nothing", async () => {
    let reads = 0;
    const { store, sleeps } = notionWith(() => {
      reads++;
      return reads === 1 ? { status: 502, body: {} } : { status: 200, body: { in_trash: false } };
    });
    await expect(store.pageState("p1")).resolves.toBe("live");
    expect(reads).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe("KeychainSecretStore", () => {
  it("keeps the old credential when the written value does not read back: nothing is deleted to retry an unproven write", async () => {
    const calls: string[][] = [];
    const store = new KeychainSecretStore("svc", "/usr/bin/security", async (_bin, args) => {
      calls.push([...args]);
      if (args[0] === "find-generic-password") return { stdout: "old-credential\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await expect(store.set("notion", "new-credential")).rejects.toThrow(KEYCHAIN_WRITE_FAILED);
    expect(calls.map((c) => c[0])).toEqual(["-i", "find-generic-password"]);
    expect(calls.some((c) => c.includes("delete-generic-password"))).toBe(false);
  });
});

describe("createJobLock", () => {
  const LOCK = "job.lock";

  it("never displaces a live holder's lock", () => {
    const dir = tempDir();
    const file = path.join(dir, LOCK);
    fs.writeFileSync(file, "4242:1");
    const lock = createJobLock({ lockFile: file, pid: 1, isAlive: () => true, log: () => undefined });
    expect(lock.acquire()).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("4242:1");
  });

  it("takes over a dead holder's lock", () => {
    const dir = tempDir();
    const file = path.join(dir, LOCK);
    fs.writeFileSync(file, "4242:1");
    const lock = createJobLock({ lockFile: file, pid: 1, now: () => 9, isAlive: () => false, log: () => undefined });
    expect(lock.acquire()).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("1:9");
  });

  it("leaves a peer's freshly written lock alone when the file changed between the read and the takeover", () => {
    const dir = tempDir();
    const file = path.join(dir, LOCK);
    fs.writeFileSync(file, "4242:1");
    let reads = 0;
    let unlinks = 0;
    const fsApi = {
      ...fs,
      readFileSync: ((p: string, enc: string) => {
        reads++;
        return reads === 1 ? "4242:1" : "5555:2";
      }) as unknown as typeof fs.readFileSync,
      unlinkSync: (() => {
        unlinks++;
      }) as unknown as typeof fs.unlinkSync
    };
    const lock = createJobLock({ lockFile: file, pid: 1, isAlive: () => false, fsApi, log: () => undefined });
    expect(lock.acquire()).toBe(false);
    expect(unlinks).toBe(0);
  });

  it("creates the lock exclusively, so a peer that wins the race is not overwritten", () => {
    const dir = tempDir();
    const file = path.join(dir, LOCK);
    const flags: unknown[] = [];
    const fsApi = {
      ...fs,
      writeFileSync: ((_p: string, _d: string, options?: { flag?: string }) => {
        flags.push(options?.flag);
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }) as unknown as typeof fs.writeFileSync
    };
    const lock = createJobLock({ lockFile: file, pid: 1, fsApi, log: () => undefined });
    expect(lock.acquire()).toBe(false);
    expect(flags).toEqual(["wx"]);
  });
});

describe("scrubSensitive", () => {
  function scrubFetch(rich: unknown[], patches: Array<{ rich_text: Array<{ text: { content: string } }> }>) {
    return (async (url: string, init: { method: string; body?: string }) => {
      const u = String(url);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (init.method === "POST" && u.includes("/query")) {
        return reply({
          results: [
            {
              id: "p1",
              properties: {
                Recorded: { date: { start: "2026-09-26T14:50:00Z" } },
                Meeting: { title: [{ plain_text: "T" }] },
                Type: { multi_select: [{ name: "Summary" }] }
              }
            }
          ]
        });
      }
      if (init.method === "GET") {
        return reply({ results: [{ id: "b1", type: "paragraph", paragraph: { rich_text: rich } }] });
      }
      patches.push((JSON.parse(String(init.body)) as { paragraph: (typeof patches)[number] }).paragraph);
      return reply({});
    }) as unknown as typeof fetch;
  }
  const run = (rich: unknown[], patches: Array<{ rich_text: Array<{ text: { content: string } }> }>) =>
    scrubSensitive({ token: "t", dataSourceId: "ds", apply: true, log: () => undefined, fetchImpl: scrubFetch(rich, patches) });
  const piece = (text: string) => ({ type: "text", plain_text: text, text: { content: text, link: null }, annotations: { bold: false } });

  it("redacts adjacent runs of the same formatting as one string, so a number split across runs is still caught (the Zap wrote whole transcripts as runs of up to 11,000 characters)", async () => {
    const patches: Array<{ rich_text: Array<{ text: { content: string } }> }> = [];
    const result = await run([piece("He gave his card number, 4111 1111 11"), piece("11 1111, thanks.")], patches);
    expect(result.blocksUpdated).toBe(1);
    expect(patches.flatMap((p) => p.rich_text.map((r) => r.text.content)).join("")).toBe("He gave his card number, [card number redacted], thanks.");
  });

  it("re-splits a redacted run longer than the 2,000 characters Notion accepts per run", async () => {
    const patches: Array<{ rich_text: Array<{ text: { content: string } }> }> = [];
    await run([piece("card number 4111 1111 1111 1111. " + "word ".repeat(1000))], patches);
    const sizes = patches.flatMap((p) => p.rich_text.map((r) => r.text.content.length));
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2000);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("runOAuthCallback", () => {
  it("binds 127.0.0.1 and ::1 only, because Plaud's registered redirect is localhost:8199 and a wider bind would let another machine answer the callback", async () => {
    const port = await freePort();
    const listen = vi.spyOn(net.Server.prototype, "listen");
    try {
      const reachable: string[] = [];
      const result = await new Promise<{ status: string }>((resolve) => {
        void runOAuthCallback({
          expectedState: "good",
          port,
          timeoutMs: 10_000,
          postSuccessDelayMs: 0,
          exchangeCode: async () => undefined,
          path: "/callback",
          onListening: () => {
            void (async () => {
              const offered = Object.values(os.networkInterfaces())
                .flat()
                .filter((entry): entry is os.NetworkInterfaceInfo => entry !== undefined && !entry.internal && entry.family === "IPv4")
                .map((entry) => entry.address);
              for (const address of offered) {
                const open = await new Promise<boolean>((done) => {
                  const socket = net.connect({ host: address, port });
                  socket.once("connect", () => {
                    socket.destroy();
                    done(true);
                  });
                  socket.once("error", () => done(false));
                });
                if (open) reachable.push(address);
              }
              await fetch(`http://127.0.0.1:${port}/callback?state=good&code=real`).catch(() => undefined);
            })();
          }
        }).then(resolve);
      });
      expect(result.status).toBe("success");
      const hosts = listen.mock.calls.map((call) => (call as unknown[])[1]);
      expect(hosts[0]).toBe("127.0.0.1");
      expect(hosts.every((host) => host === "127.0.0.1" || host === "::1")).toBe(true);
      expect(reachable).toEqual([]);
    } finally {
      listen.mockRestore();
    }
  });

  it("rejects an unexpected state without exchanging a code", async () => {
    const port = await freePort();
    const codes: string[] = [];
    const done = runOAuthCallback({
      expectedState: "good",
      port,
      timeoutMs: 10_000,
      postSuccessDelayMs: 0,
      exchangeCode: async (code) => {
        codes.push(code);
      },
      onListening: () => {
        void (async () => {
          await fetch(`http://127.0.0.1:${port}/callback?state=bad&code=stolen`).catch(() => undefined);
          await fetch(`http://127.0.0.1:${port}/callback?state=good&code=real`).catch(() => undefined);
        })();
      },
      path: "/callback"
    });
    const result = await done;
    expect(result.status).toBe("success");
    expect(codes).toEqual(["real"]);
  });
});
