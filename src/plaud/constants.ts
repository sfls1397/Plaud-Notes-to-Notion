/**
 * Plaud consumer MCP OAuth — same public-client defaults as `@plaud-ai/mcp`
 * (and Plaud-Index-MCP). Published identifiers/URLs, not secrets.
 */
export const DEFAULT_MCP_CLIENT_ID = "client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674";
export const DEFAULT_AUTHORIZATION_URL = "https://web.plaud.ai/platform/oauth";
export const DEFAULT_TOKEN_URL = "https://platform.plaud.ai/developer/api/oauth/third-party/access-token";
export const DEFAULT_REFRESH_URL =
  "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh";
/** Data plane behind the Plaud MCP tools (`list_files` / `get_file`). */
export const DEFAULT_MCP_API_BASE = "https://platform.plaud.ai/developer/api";

/** Plaud's registered loopback redirect for this public client. */
export const OAUTH_CALLBACK_PORT = 8199;
export const OAUTH_CALLBACK_PATH = "/auth/callback";
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
export const LOGIN_TIMEOUT_MS = 180_000;
export const REFRESH_SKEW_MS = 60_000;

export const RELLOGIN_MESSAGE = "Plaud sign-in expired. Re-run: plaud-notes-to-notion login --profile <name>";
export const AUTH_TRANSIENT_MESSAGE =
  "Cannot reach Plaud (network or server error). Will retry next cycle; tokens were not cleared.";
