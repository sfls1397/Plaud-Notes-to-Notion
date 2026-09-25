import {
  DEFAULT_AUTHORIZATION_URL,
  DEFAULT_MCP_API_BASE,
  DEFAULT_MCP_CLIENT_ID,
  DEFAULT_REFRESH_URL,
  DEFAULT_TOKEN_URL,
  OAUTH_REDIRECT_URI
} from "./constants.js";
import { AuthExpiredError, AuthTransportError, isTransportError } from "./errors.js";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";
import type { AuthorizationRequest, OAuthEndpoints, PlaudTokenSet } from "./types.js";
import { redactSecrets } from "../redact.js";

function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      return false;
    }
    if (url.username || url.password) {
      return false;
    }
    return url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

export function resolveOAuthEndpoints(env: NodeJS.ProcessEnv = process.env): OAuthEndpoints {
  const clientId =
    (typeof env.PLAUD_MCP_CLIENT_ID === "string" && env.PLAUD_MCP_CLIENT_ID.trim()) ||
    (typeof env.PLAUD_CLIENT_ID === "string" && env.PLAUD_CLIENT_ID.trim()) ||
    DEFAULT_MCP_CLIENT_ID;
  const redirectOverride =
    typeof env.PLAUD_CALLBACK_URL === "string" ? env.PLAUD_CALLBACK_URL.trim() : "";
  const redirectUri =
    redirectOverride && isLoopbackRedirect(redirectOverride) ? redirectOverride : OAUTH_REDIRECT_URI;
  return {
    clientId,
    redirectUri,
    authorizationUrl:
      (typeof env.PLAUD_AUTH_URL === "string" && env.PLAUD_AUTH_URL.trim()) || DEFAULT_AUTHORIZATION_URL,
    tokenUrl: (typeof env.PLAUD_TOKEN_URL === "string" && env.PLAUD_TOKEN_URL.trim()) || DEFAULT_TOKEN_URL,
    refreshUrl: (typeof env.PLAUD_REFRESH_URL === "string" && env.PLAUD_REFRESH_URL.trim()) || DEFAULT_REFRESH_URL,
    apiBase: (typeof env.PLAUD_MCP_API_BASE === "string" && env.PLAUD_MCP_API_BASE.trim()) || DEFAULT_MCP_API_BASE
  };
}

export function createAuthorizationRequest(endpoints: OAuthEndpoints): AuthorizationRequest {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const params = new URLSearchParams({
    client_id: endpoints.clientId,
    redirect_uri: endpoints.redirectUri,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });
  return {
    url: `${endpoints.authorizationUrl}?${params.toString()}`,
    codeVerifier,
    state
  };
}

export function parseTokenSet(data: unknown, nowMs: number, previous?: PlaudTokenSet | null): PlaudTokenSet {
  if (!data || typeof data !== "object") {
    throw new Error("Plaud token response was not JSON");
  }
  const rec = data as Record<string, unknown>;
  const access =
    typeof rec.access_token === "string" && rec.access_token.trim() ? rec.access_token.trim() : "";
  if (!access) {
    throw new Error("Plaud token response missing access_token");
  }
  const refresh =
    typeof rec.refresh_token === "string" && rec.refresh_token.trim()
      ? rec.refresh_token.trim()
      : previous?.refresh_token;
  const expiresIn = typeof rec.expires_in === "number" && Number.isFinite(rec.expires_in) ? rec.expires_in : null;
  const tokenType = typeof rec.token_type === "string" && rec.token_type.trim() ? rec.token_type.trim() : "Bearer";
  const tokenSet: PlaudTokenSet = {
    access_token: access,
    token_type: tokenType
  };
  if (refresh) {
    tokenSet.refresh_token = refresh;
  }
  if (expiresIn !== null) {
    tokenSet.expires_at = nowMs + expiresIn * 1000;
  }
  return tokenSet;
}

export function parseStoredTokenSet(raw: string): PlaudTokenSet | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    const access = typeof rec.access_token === "string" ? rec.access_token.trim() : "";
    if (!access) {
      return null;
    }
    const tokenSet: PlaudTokenSet = { access_token: access };
    if (typeof rec.refresh_token === "string" && rec.refresh_token.trim()) {
      tokenSet.refresh_token = rec.refresh_token.trim();
    }
    if (typeof rec.token_type === "string" && rec.token_type.trim()) {
      tokenSet.token_type = rec.token_type.trim();
    }
    if (typeof rec.expires_at === "number" && Number.isFinite(rec.expires_at)) {
      tokenSet.expires_at = rec.expires_at;
    }
    return tokenSet;
  } catch {
    return null;
  }
}

export function serializeTokenSet(tokenSet: PlaudTokenSet): string {
  return JSON.stringify(tokenSet);
}

export function tokenNeedsRefresh(tokenSet: PlaudTokenSet, nowMs: number, skewMs: number): boolean {
  if (!tokenSet.expires_at) {
    return false;
  }
  return nowMs > tokenSet.expires_at - skewMs;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "non_json", status: response.status };
  }
}

export async function exchangeAuthorizationCode(options: {
  endpoints: OAuthEndpoints;
  code: string;
  codeVerifier: string;
  state: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<PlaudTokenSet> {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const basicAuth = Buffer.from(`${options.endpoints.clientId}:`).toString("base64");
  let response: Response;
  try {
    response = await fetchImpl(options.endpoints.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        code: options.code,
        redirect_uri: options.endpoints.redirectUri,
        code_verifier: options.codeVerifier,
        state: options.state
      })
    });
    } catch {
      throw new AuthTransportError("Plaud token exchange failed (network).");
    }
  if (!response.ok) {
    throw new Error(redactSecrets(`Plaud token exchange failed (${response.status}).`));
  }
  const data = await readJson(response);
  return parseTokenSet(data, now());
}

export async function refreshTokenSet(options: {
  endpoints: OAuthEndpoints;
  tokenSet: PlaudTokenSet;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<PlaudTokenSet> {
  const refreshToken = options.tokenSet.refresh_token;
  if (!refreshToken) {
    throw new AuthExpiredError();
  }
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  let response: Response;
  try {
    response = await fetchImpl(options.endpoints.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({ refresh_token: refreshToken })
    });
  } catch (err) {
    if (isTransportError(err)) {
      throw new AuthTransportError("Plaud token refresh failed (network).");
    }
    throw err;
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 400 || response.status === 403) {
      throw new AuthExpiredError();
    }
    if (response.status >= 500) {
      throw new AuthTransportError(`Plaud token refresh failed (${response.status}).`);
    }
    throw new AuthExpiredError();
  }
  const data = await readJson(response);
  return parseTokenSet(data, now(), options.tokenSet);
}
