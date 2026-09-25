import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "./constants.js";
import { redactSecrets } from "../redact.js";

export type OAuthCallbackStatus = "success" | "timeout" | "denied" | "exchange-failed" | "listen-failed";

export interface OAuthCallbackResult {
  status: OAuthCallbackStatus;
  error?: Error;
}

const SUCCESS_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Plaud</title></head><body style=\"font-family:system-ui;padding:2rem;text-align:center;\"><h1>Authorization successful</h1><p>You can close this tab and return to the terminal.</p></body></html>";
const NEUTRAL_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Plaud</title></head><body style=\"font-family:system-ui;padding:2rem;text-align:center;\"><h1>Continue authorization in the original window.</h1><p>This page can be closed.</p></body></html>";

function errorHtml(message: string): string {
  const escaped = redactSecrets(message).replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plaud</title></head><body style="font-family:system-ui;padding:2rem;text-align:center;"><h1>Authorization failed</h1><p>${escaped}</p></body></html>`;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
const IPV6_UNAVAILABLE = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL", "EINVAL", "EPROTONOSUPPORT"]);

function listenOne(
  port: number,
  host: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function closeServers(servers: ReturnType<typeof createServer>[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          try {
            server.closeAllConnections?.();
          } catch {
            /* ignore */
          }
          server.close(() => resolve());
        })
    )
  );
}

async function listenLoopback(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<ReturnType<typeof createServer>[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  for (const host of LOOPBACK_HOSTS) {
    try {
      servers.push(await listenOne(port, host, handler));
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code ?? "") : "";
      if (host !== "127.0.0.1" && IPV6_UNAVAILABLE.has(code)) {
        continue;
      }
      await closeServers(servers);
      throw err;
    }
  }
  return servers;
}

export interface RunOAuthCallbackOptions {
  expectedState: string;
  exchangeCode: (code: string) => Promise<void>;
  port?: number;
  path?: string;
  timeoutMs?: number;
  onListening?: () => void;
  postSuccessDelayMs?: number;
}

/**
 * Loopback OAuth callback on localhost:8199 (Plaud's registered redirect).
 * Binds 127.0.0.1 and ::1 only. Rejects unexpected `state` without exchanging a code.
 */
export function runOAuthCallback(options: RunOAuthCallbackOptions): Promise<OAuthCallbackResult> {
  const port = options.port ?? OAUTH_CALLBACK_PORT;
  const callbackPath = options.path ?? OAUTH_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const postSuccessDelayMs = options.postSuccessDelayMs ?? 1500;

  return new Promise((resolve) => {
    let settled = false;
    let exchangeStarted = false;
    let exchangeSucceeded = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let servers: ReturnType<typeof createServer>[] = [];

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }
      const error = reqUrl.searchParams.get("error");
      const state = reqUrl.searchParams.get("state");
      const code = reqUrl.searchParams.get("code");
      if (error) {
        const desc = reqUrl.searchParams.get("error_description") ?? error;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml(`Authorization denied.`));
        finalize({ status: "denied", error: new Error(desc) });
        return;
      }
      if (!state || state !== options.expectedState) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(NEUTRAL_HTML);
        return;
      }
      if (exchangeSucceeded) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        return;
      }
      if (!code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(NEUTRAL_HTML);
        return;
      }
      if (exchangeStarted) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(NEUTRAL_HTML);
        return;
      }
      exchangeStarted = true;
      options.exchangeCode(code).then(
        () => {
          exchangeSucceeded = true;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(SUCCESS_HTML);
          finalize({ status: "success" });
        },
        (err) => {
          const e = err instanceof Error ? err : new Error(String(err));
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(errorHtml("Token exchange failed."));
          finalize({ status: "exchange-failed", error: e });
        }
      );
    };

    timeoutId = setTimeout(() => {
      finalize({ status: "timeout" }, true);
    }, timeoutMs);

    listenLoopback(port, handler).then(
      (bound) => {
        if (settled) {
          void closeServers(bound);
          return;
        }
        servers = bound;
        for (const server of servers) {
          server.on("error", (err) => {
            if (settled) {
              return;
            }
            finalize(
              { status: "listen-failed", error: new Error(`callback server error: ${err.message}`) },
              true
            );
          });
        }
        options.onListening?.();
      },
      (err) => {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code ?? "") : "";
        const message =
          code === "EADDRINUSE"
            ? `port ${port} is in use — another Plaud login may still be running. Wait a few seconds and retry.`
            : `callback server error: ${err instanceof Error ? err.message : String(err)}`;
        finalize({ status: "listen-failed", error: new Error(message) }, true);
      }
    );

    function finalize(result: OAuthCallbackResult, immediate = false): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const close = (): void => {
        void closeServers(servers).then(() => resolve(result));
      };
      if (immediate || result.status !== "success") {
        close();
      } else {
        const closeTimeoutId = setTimeout(close, postSuccessDelayMs);
        closeTimeoutId.unref?.();
      }
    }
  });
}
