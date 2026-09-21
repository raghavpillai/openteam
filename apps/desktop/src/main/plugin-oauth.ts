import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { createOpenTeamClient } from "@openteam/client-core";

type Client = Pick<
  ReturnType<typeof createOpenTeamClient>,
  | "pluginConfiguration"
  | "authenticatePlugin"
  | "finishPluginAuthentication"
  | "cancelPluginAuthentication"
  | "pluginConnectionStatuses"
>;
type Started = { authorizationUrl: string; status: string };
export type PluginOAuthResult = {
  connectionId: string;
  status: "ready" | "cancelled" | "error";
  message?: string;
};
interface Attempt {
  connectionId: string;
  scope: string;
  client: Client;
  server: Server;
  redirectUrl: string;
  started?: Started;
  state?: string;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

/** Receives codes on this computer; only the selected backend exchanges/stores tokens. */
export class DesktopPluginOAuth {
  private attempts = new Map<string, Attempt>();
  private starts = new Map<string, Promise<Started>>();
  private generation = 0;

  constructor(
    private readonly onResult: (result: PluginOAuthResult) => void,
    private readonly timeoutMs = 5 * 60_000
  ) {}

  get sessionGeneration() {
    return this.generation;
  }

  start(scope: string, connectionId: string, client: Client, force = false): Promise<Started> {
    const key = `${scope}:${connectionId}`;
    const starting = this.starts.get(key);
    if (starting) return starting;
    const pending = this.attempts.get(connectionId);
    if (!force && pending?.scope === scope && pending.started)
      return Promise.resolve(pending.started);
    const generation = this.generation;
    const result = this.begin(scope, connectionId, client, force, generation);
    this.starts.set(key, result);
    void result
      .finally(() => {
        if (this.starts.get(key) === result) this.starts.delete(key);
      })
      .catch(() => {});
    return result;
  }

  private async begin(
    scope: string,
    connectionId: string,
    client: Client,
    force: boolean,
    generation: number
  ): Promise<Started> {
    const notify = (result: PluginOAuthResult) => {
      if (generation === this.generation) this.onResult(result);
    };
    if (this.attempts.size + this.starts.size >= 8)
      throw new Error("Finish or cancel an existing plugin sign-in first.");
    await this.cancel(connectionId);
    const config = await client.pluginConfiguration(connectionId);
    if (generation !== this.generation)
      throw new Error("The server or sign-in session changed. Try again.");
    if ((config.resolvedOAuthCallbackMode ?? config.oauthCallbackMode ?? "auto") !== "desktop")
      return client.authenticatePlugin(connectionId, force);
    let attempt: Attempt;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const reject = () => {
        response.writeHead(400);
        response.end("This sign-in callback is not valid. Return to OpenTeam.");
      };
      if (
        !attempt ||
        attempt.closed ||
        !attempt.state ||
        request.method !== "GET" ||
        !request.url ||
        request.url.length > 16_384 ||
        request.headers.host !== new URL(attempt.redirectUrl).host
      )
        return reject();
      const callback = new URL(request.url, attempt.redirectUrl);
      const state = callback.searchParams.get("state") ?? "";
      const code = callback.searchParams.get("code") ?? undefined;
      const error = callback.searchParams.get("error") ?? undefined;
      const iss = callback.searchParams.get("iss") ?? undefined;
      if (
        callback.pathname !== "/callback" ||
        callback.origin !== new URL(attempt.redirectUrl).origin ||
        ["state", "code", "error", "iss"].some(
          (key) => callback.searchParams.getAll(key).length > 1
        ) ||
        !sameState(state, attempt.state) ||
        Boolean(code) === Boolean(error) ||
        (code?.length ?? 0) > 8192 ||
        (error?.length ?? 0) > 1000 ||
        (iss?.length ?? 0) > 2000
      )
        return reject();
      response.end(
        "<!doctype html><title>OpenTeam sign-in</title><p>Authorization received. Return to OpenTeam to see the result.</p>"
      );
      this.stop(attempt);
      void client
        .finishPluginAuthentication(connectionId, {
          redirectUrl: attempt.redirectUrl,
          state,
          code,
          error,
          iss,
        })
        .then(() =>
          notify({
            connectionId,
            status: !error ? "ready" : error === "access_denied" ? "cancelled" : "error",
            ...(error && error !== "access_denied"
              ? { message: "The provider could not complete sign-in. Try again." }
              : {}),
          })
        )
        .catch(async () => {
          // A lost HTTP response must not cause a second redemption of a one-time code.
          const status = await client.pluginConnectionStatuses([connectionId]).catch(() => null);
          if (status?.connections[0]?.status === "ready") notify({ connectionId, status: "ready" });
          else
            notify({
              connectionId,
              status: "error",
              message:
                "Could not finish plugin sign-in. Check the connection status and try again.",
            });
        });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 8;
    const port = config.oauthLoopbackPort ?? 0;
    if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535)))
      throw new Error("Choose an available callback port from 1024 to 65535, or 0 for automatic.");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch {
      server.close();
      throw new Error(
        "The plugin callback port is unavailable. Close the conflicting app or choose another port in connection settings."
      );
    }
    if (generation !== this.generation) {
      server.close();
      throw new Error("Plugin sign-in was cancelled. Try again.");
    }
    attempt = {
      connectionId,
      scope,
      client,
      server,
      redirectUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
      closed: false,
    };
    this.attempts.set(connectionId, attempt);
    server.on("error", () => {
      this.stop(attempt);
      void this.cancelRemote(attempt);
      notify({
        connectionId,
        status: "error",
        message: "The plugin sign-in listener stopped. Try again.",
      });
    });
    attempt.timer = setTimeout(() => {
      this.stop(attempt);
      void this.cancelRemote(attempt);
      notify({
        connectionId,
        status: "error",
        message: "Plugin sign-in timed out. Try again when ready.",
      });
    }, this.timeoutMs);
    attempt.timer.unref();
    try {
      const started = await client.authenticatePlugin(connectionId, force, attempt.redirectUrl);
      const url = new URL(started.authorizationUrl);
      attempt.state = url.searchParams.get("state") ?? undefined;
      if (
        url.searchParams.get("redirect_uri") !== attempt.redirectUrl ||
        !attempt.state ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        ) ||
        url.username ||
        url.password
      )
        throw new Error(
          "The server did not accept the desktop callback. Update the server or select Server callback in connection settings."
        );
      if (attempt.closed || generation !== this.generation)
        throw new Error("Plugin sign-in was cancelled. Try again.");
      attempt.started = started;
      return started;
    } catch (error) {
      this.stop(attempt);
      await this.cancelRemote(attempt);
      throw error;
    }
  }

  async cancel(connectionId: string, state?: string): Promise<boolean> {
    const attempt = this.attempts.get(connectionId);
    if (!attempt || (state && attempt.state !== state)) return false;
    this.stop(attempt);
    await this.cancelRemote(attempt);
    return true;
  }

  closeAll() {
    this.generation++;
    for (const attempt of this.attempts.values()) {
      this.stop(attempt);
      void this.cancelRemote(attempt);
    }
  }

  private stop(attempt: Attempt) {
    attempt.closed = true;
    clearTimeout(attempt.timer);
    attempt.server.close();
    attempt.server.closeIdleConnections();
    if (this.attempts.get(attempt.connectionId) === attempt)
      this.attempts.delete(attempt.connectionId);
  }

  private async cancelRemote(attempt: Attempt) {
    if (attempt.state)
      await attempt.client
        .cancelPluginAuthentication(attempt.connectionId, attempt.state, attempt.redirectUrl)
        .catch(() => {});
  }
}

const sameState = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
