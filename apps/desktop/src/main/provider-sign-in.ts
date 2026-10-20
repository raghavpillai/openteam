import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type ProviderSignInCapture =
  | { status: "captured"; callbackUrl: string }
  | { status: "unavailable"; message: string }
  | { status: "cancelled" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const SIGNED_IN_PAGE =
  "<!doctype html><meta charset=utf-8><title>OpenTeam</title>" +
  '<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">' +
  "<p>You're signed in. Return to OpenTeam.</p>";

/**
 * Model provider sign-in runs on the OpenTeam server, so the provider's localhost
 * redirect would land on the server's container instead of this computer. The
 * desktop listens on that same address for one redirect and hands it back, the
 * same way a person would paste the redirect URL.
 */
export class ProviderSignInCallback {
  private active: { finish: (result: ProviderSignInCapture) => void } | null = null;

  constructor(private readonly timeoutMs = 10 * 60_000) {}

  async capture(
    authorizationUrl: string,
    redirectUri: string,
    openBrowser: (url: string) => Promise<void>
  ): Promise<ProviderSignInCapture> {
    const authorization = new URL(authorizationUrl);
    const redirect = new URL(redirectUri);
    const port = Number(redirect.port);
    if (
      authorization.protocol !== "https:" ||
      authorization.username ||
      authorization.password ||
      redirect.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(redirect.hostname) ||
      !Number.isInteger(port) ||
      port < 1024 ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    ) {
      return { status: "unavailable", message: "This sign-in can't finish automatically." };
    }
    this.cancel();
    const expectedState = authorization.searchParams.get("state");
    const servers: Server[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: (result: ProviderSignInCapture) => void;
    const result = new Promise<ProviderSignInCapture>((resolve) => {
      settle = resolve;
    });
    const finish = (value: ProviderSignInCapture) => {
      if (this.active?.finish === finish) this.active = null;
      clearTimeout(timer);
      for (const server of servers) {
        server.close();
        server.closeIdleConnections();
      }
      settle(value);
    };
    this.active = { finish };

    const handler = (request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      const callback = new URL(request.url ?? "/", redirect.origin);
      const state = callback.searchParams.get("state");
      if (
        request.method !== "GET" ||
        (request.url?.length ?? 0) > 16_384 ||
        callback.pathname !== redirect.pathname ||
        !(callback.searchParams.has("code") || callback.searchParams.has("error")) ||
        (expectedState !== null && (state === null || !sameText(state, expectedState)))
      ) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(SIGNED_IN_PAGE);
      finish({
        status: "captured",
        callbackUrl: `${redirect.origin}${callback.pathname}${callback.search}`,
      });
    };

    // Browsers may resolve "localhost" to either loopback family; IPv6 is best effort.
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handler);
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        servers.push(server);
      } catch {
        server.close();
        if (host === "127.0.0.1") {
          finish({
            status: "unavailable",
            message: `Another app is using port ${port}, so this sign-in can't finish automatically.`,
          });
          // The sign-in still works by pasting the address the browser lands on, so the
          // page opens anyway rather than leaving people to find a link.
          await openBrowser(authorization.href).catch(() => {});
          return result;
        }
      }
    }
    timer = setTimeout(() => finish({ status: "cancelled" }), this.timeoutMs);
    timer.unref();
    try {
      await openBrowser(authorization.href);
    } catch {
      finish({ status: "unavailable", message: "Could not open your browser." });
    }
    return result;
  }

  cancel(): void {
    this.active?.finish({ status: "cancelled" });
  }
}

const sameText = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
