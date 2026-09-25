import { REFRESH_SKEW_MS } from "./constants.js";
import { AuthExpiredError, isAuthExpiredError, isTransportError } from "./errors.js";
import {
  parseStoredTokenSet,
  refreshTokenSet,
  resolveOAuthEndpoints,
  serializeTokenSet,
  tokenNeedsRefresh
} from "./oauth.js";
import type { OAuthEndpoints, PlaudTokenSet } from "./types.js";
import type { SecretStore } from "../secrets.js";

export interface PlaudAuthSession {
  endpoints: OAuthEndpoints;
  getAccessToken(): Promise<string | null>;
  /** Force a refresh (after a 401). */
  refresh(): Promise<string>;
  save(tokenSet: PlaudTokenSet): Promise<void>;
  clear(): Promise<void>;
  peek(): PlaudTokenSet | null;
}

/**
 * One Plaud sign-in stored in Keychain under a profile-specific account.
 * Before refreshing, re-reads Keychain: if another process (daemon vs a manual
 * CLI run) already rotated the refresh token, use that instead of burning ours.
 */
export async function createAuthSession(options: {
  store: SecretStore;
  account: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<PlaudAuthSession> {
  const now = options.now || Date.now;
  const endpoints = resolveOAuthEndpoints(options.env || process.env);
  const load = async (): Promise<PlaudTokenSet | null> => {
    const raw = await options.store.get(options.account);
    return raw ? parseStoredTokenSet(raw) : null;
  };
  let current = await load();

  async function persist(next: PlaudTokenSet): Promise<void> {
    current = next;
    await options.store.set(options.account, serializeTokenSet(next));
  }

  async function refresh(): Promise<string> {
    const stored = await load();
    if (stored && current && stored.access_token !== current.access_token && !tokenNeedsRefresh(stored, now(), REFRESH_SKEW_MS)) {
      current = stored;
      return stored.access_token;
    }
    if (stored) {
      current = stored;
    }
    if (!current?.refresh_token) {
      throw new AuthExpiredError();
    }
    try {
      const next = await refreshTokenSet({ endpoints, tokenSet: current, fetchImpl: options.fetchImpl, now });
      await persist(next);
      return next.access_token;
    } catch (err) {
      if (isTransportError(err) || isAuthExpiredError(err)) {
        throw err;
      }
      throw new AuthExpiredError();
    }
  }

  async function getAccessToken(): Promise<string | null> {
    if (!current) {
      current = await load();
      if (!current) {
        return null;
      }
    }
    if (tokenNeedsRefresh(current, now(), REFRESH_SKEW_MS)) {
      try {
        return await refresh();
      } catch (err) {
        if (isTransportError(err) && current?.access_token) {
          return current.access_token;
        }
        throw err;
      }
    }
    return current.access_token;
  }

  return {
    endpoints,
    getAccessToken,
    refresh,
    save: persist,
    clear: async () => {
      current = null;
      await options.store.delete(options.account);
    },
    peek: () => current
  };
}
