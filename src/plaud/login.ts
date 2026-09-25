import { spawn } from "node:child_process";
import { runOAuthCallback } from "./callback.js";
import { LOGIN_TIMEOUT_MS, OAUTH_CALLBACK_PORT } from "./constants.js";
import { createAuthorizationRequest, exchangeAuthorizationCode } from "./oauth.js";
import { createAuthSession } from "./session.js";
import type { SecretStore } from "../secrets.js";
import { redactSecrets } from "../redact.js";

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const cmd = platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function probeCurrentUser(options: {
  token: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
}): Promise<"ok" | "unauthorized" | "error"> {
  try {
    const res = await (options.fetchImpl || fetch)(
      `${options.apiBase.replace(/\/$/, "")}/open/third-party/users/current`,
      { headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" } }
    );
    if (res.status === 401 || res.status === 403) {
      return "unauthorized";
    }
    return res.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

/** Plaud consumer OAuth (public client + PKCE) for one profile; tokens go to Keychain. */
export async function runPlaudLogin(options: {
  profile: string;
  store: SecretStore;
  account: string;
  noBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}): Promise<number> {
  const log = options.log || ((msg: string) => console.error(msg));
  const session = await createAuthSession({
    store: options.store,
    account: options.account,
    env: options.env,
    fetchImpl: options.fetchImpl
  });
  const endpoints = session.endpoints;

  const existing = await session.getAccessToken().catch(() => null);
  if (existing) {
    const probe = await probeCurrentUser({ token: existing, apiBase: endpoints.apiBase, fetchImpl: options.fetchImpl });
    if (probe === "ok") {
      log(`Profile ${options.profile} is already signed in to Plaud (${options.store.describe()}).`);
      return 0;
    }
    if (probe === "error") {
      log("Cannot reach Plaud to check the saved sign-in. Try again when the network is up.");
      return 1;
    }
    await session.clear();
  }

  const request = createAuthorizationRequest(endpoints);
  log(`Plaud sign-in for profile "${options.profile}". Sign in as that person's Plaud account, then click Authorize.`);
  log(request.url);
  log(`Waiting up to ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} minutes for the callback on localhost:${OAUTH_CALLBACK_PORT}…`);
  if (!options.noBrowser) {
    try {
      openBrowser(request.url);
    } catch {
      log("Could not open a browser. Open the URL above on this Mac.");
    }
  }

  const result = await runOAuthCallback({
    expectedState: request.state,
    timeoutMs: LOGIN_TIMEOUT_MS,
    exchangeCode: async (code) => {
      const tokenSet = await exchangeAuthorizationCode({
        endpoints,
        code,
        codeVerifier: request.codeVerifier,
        state: request.state,
        fetchImpl: options.fetchImpl
      });
      await session.save(tokenSet);
    }
  });

  if (result.status !== "success") {
    log(redactSecrets(`Plaud sign-in did not finish (${result.status}${result.error ? `: ${result.error.message}` : ""}).`));
    return 1;
  }
  const token = await session.getAccessToken();
  const probe = token
    ? await probeCurrentUser({ token, apiBase: endpoints.apiBase, fetchImpl: options.fetchImpl })
    : "unauthorized";
  if (probe !== "ok") {
    await session.clear();
    log("Plaud accepted the sign-in but the API rejected the token. Nothing was saved.");
    return 1;
  }
  log(`Signed in. Plaud tokens for profile ${options.profile} are in ${options.store.describe()}; the service refreshes them on its own.`);
  return 0;
}
