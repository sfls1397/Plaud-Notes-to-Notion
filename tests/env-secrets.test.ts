import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { anthropicKey, buildProfileRuntime, openaiKey } from "../src/runtime.js";
import { MemorySecretStore, readSecret, secretEnvName } from "../src/secrets.js";

// Fake values only. Never a real key.
const FAKE_ENV_TOKEN = "fake-env-notion-token";
const FAKE_KEYCHAIN_TOKEN = "fake-keychain-notion-token";

const profile = parseConfig({
  profiles: { peter: { owner: "Alex Example", notionDataSourceId: "0".repeat(32), startAfter: "2026-01-01T00:00:00Z" } }
}).profiles.peter;

async function notionTokenUsed(env: NodeJS.ProcessEnv, keychain: Record<string, string>): Promise<string> {
  const store = new MemorySecretStore();
  for (const [k, v] of Object.entries(keychain)) await store.set(k, v);
  const rt = await buildProfileRuntime({ name: "peter", profile, config: parseConfig({}), store, env, needPlaud: false, needLabeler: false });
  // HttpNotionStore keeps the token in its private options; it sends exactly this as the Bearer token.
  return (rt.notion as unknown as { options: { token: string } }).options.token;
}

describe("secretEnvName", () => {
  it("maps each Keychain account to its environment variable", () => {
    expect(secretEnvName("notion:peter")).toBe("NOTION_TOKEN_PETER");
    expect(secretEnvName("notion:tim")).toBe("NOTION_TOKEN_TIM");
    expect(secretEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(secretEnvName("anthropic:peter")).toBe("ANTHROPIC_API_KEY_PETER");
    expect(secretEnvName("openai")).toBe("OPENAI_API_KEY");
    expect(secretEnvName("openai:tim")).toBe("OPENAI_API_KEY_TIM");
    expect(secretEnvName("notion:work-2")).toBe("NOTION_TOKEN_WORK_2");
  });
  it("never maps the Plaud sessions: they stay in the Keychain", () => {
    expect(secretEnvName("plaud:peter")).toBeNull();
    expect(secretEnvName("plaud:tim")).toBeNull();
    expect(secretEnvName("something-else")).toBeNull();
  });
});

describe("readSecret: environment first, Keychain second", () => {
  it("uses the variable when it is set and the Keychain is empty", async () => {
    const store = new MemorySecretStore();
    expect(await readSecret(store, "notion:peter", { NOTION_TOKEN_PETER: FAKE_ENV_TOKEN })).toBe(FAKE_ENV_TOKEN);
  });
  it("uses the variable over the Keychain item when both exist", async () => {
    const store = new MemorySecretStore();
    await store.set("notion:peter", FAKE_KEYCHAIN_TOKEN);
    expect(await readSecret(store, "notion:peter", { NOTION_TOKEN_PETER: FAKE_ENV_TOKEN })).toBe(FAKE_ENV_TOKEN);
  });
  it("falls back to the Keychain when the variable is unset, empty or blank", async () => {
    const store = new MemorySecretStore();
    await store.set("notion:peter", FAKE_KEYCHAIN_TOKEN);
    expect(await readSecret(store, "notion:peter", {})).toBe(FAKE_KEYCHAIN_TOKEN);
    expect(await readSecret(store, "notion:peter", { NOTION_TOKEN_PETER: "" })).toBe(FAKE_KEYCHAIN_TOKEN);
    expect(await readSecret(store, "notion:peter", { NOTION_TOKEN_PETER: "  \n" })).toBe(FAKE_KEYCHAIN_TOKEN);
  });
  it("does not read another profile's variable", async () => {
    const store = new MemorySecretStore();
    expect(await readSecret(store, "notion:tim", { NOTION_TOKEN_PETER: FAKE_ENV_TOKEN })).toBeNull();
  });
  it("ignores the environment for Plaud sessions", async () => {
    const store = new MemorySecretStore();
    await store.set("plaud:peter", "fake-session-json");
    expect(await readSecret(store, "plaud:peter", { PLAUD_PETER: "x" })).toBe("fake-session-json");
  });
});

describe("the daemon's Notion token", () => {
  it("comes from NOTION_TOKEN_<PROFILE> when set, with the Keychain fake empty", async () => {
    expect(await notionTokenUsed({ NOTION_TOKEN_PETER: FAKE_ENV_TOKEN }, {})).toBe(FAKE_ENV_TOKEN);
  });
  it("comes from the Keychain as today when the variable is unset", async () => {
    expect(await notionTokenUsed({}, { "notion:peter": FAKE_KEYCHAIN_TOKEN })).toBe(FAKE_KEYCHAIN_TOKEN);
  });
  it("still names set-secret notion when neither is there", async () => {
    await expect(notionTokenUsed({}, {})).rejects.toThrow(/set-secret notion --profile peter/);
  });
});

describe("LLM keys keep today's order: the profile's own key, then the shared key", () => {
  const storeWith = async (items: Record<string, string>) => {
    const store = new MemorySecretStore();
    for (const [k, v] of Object.entries(items)) await store.set(k, v);
    return store;
  };
  it("profile variable beats everything", async () => {
    const store = await storeWith({ "anthropic:peter": "kc-own", anthropic: "kc-shared" });
    expect(await anthropicKey(store, "peter", { ANTHROPIC_API_KEY_PETER: "env-own", ANTHROPIC_API_KEY: "env-shared" })).toBe("env-own");
  });
  it("the profile's own Keychain key beats the shared variable, as the running service does today", async () => {
    const store = await storeWith({ "anthropic:peter": "kc-own" });
    expect(await anthropicKey(store, "peter", { ANTHROPIC_API_KEY: "env-shared" })).toBe("kc-own");
  });
  it("shared variable beats the shared Keychain key", async () => {
    const store = await storeWith({ anthropic: "kc-shared" });
    expect(await anthropicKey(store, "tim", { ANTHROPIC_API_KEY: "env-shared" })).toBe("env-shared");
  });
  it("falls back to the shared Keychain key when nothing else is set", async () => {
    const store = await storeWith({ anthropic: "kc-shared" });
    expect(await anthropicKey(store, "tim", {})).toBe("kc-shared");
  });
  it("Peter's profile under infisical-run (all variables, empty Keychain) gets its own key", async () => {
    const store = await storeWith({});
    expect(await anthropicKey(store, "peter", { ANTHROPIC_API_KEY_PETER: "env-own", ANTHROPIC_API_KEY: "env-shared" })).toBe("env-own");
    expect(await anthropicKey(store, "tim", { ANTHROPIC_API_KEY_PETER: "env-own", ANTHROPIC_API_KEY: "env-shared" })).toBe("env-shared");
  });
  it("OpenAI follows the same order", async () => {
    expect(await openaiKey(await storeWith({}), "tim", { OPENAI_API_KEY: "env-shared" })).toBe("env-shared");
    expect(await openaiKey(await storeWith({ openai: "kc-shared" }), "tim", {})).toBe("kc-shared");
    expect(await openaiKey(await storeWith({ openai: "kc-shared" }), "tim", { OPENAI_API_KEY_TIM: "env-own" })).toBe("env-own");
    await expect(openaiKey(await storeWith({}), "tim", { OPENAI_API_KEY: "" })).rejects.toThrow(/set-secret openai/);
  });
});

describe("log redaction covers the per-profile variable names", () => {
  it("hides NOTION_TOKEN_<PROFILE> and ANTHROPIC_API_KEY_<PROFILE> values", async () => {
    const { redactSecrets } = await import("../src/redact.js");
    const out = redactSecrets("NOTION_TOKEN_PETER=fakevalue111 ANTHROPIC_API_KEY_PETER=fakevalue222 OPENAI_API_KEY_TIM: fakevalue333");
    expect(out).not.toContain("fakevalue111");
    expect(out).not.toContain("fakevalue222");
    expect(out).not.toContain("fakevalue333");
  });
});
