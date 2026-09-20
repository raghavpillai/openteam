import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { randomBytes } from "node:crypto";
import { ApiError } from "@openteam/contracts";

// Packaged Electron omits Origin on some fetches (or uses "null"), but sends
// "file://" for WebSocket. These are opaque/native origins. HTTP origins stay
// exact; every connection still requires its one-use authenticated ticket.
const viewerOrigin = (origin: string | null) => origin === "file://" || origin === "null" ? null : origin;

export interface VncIdentity { botId: string; sessionId: string | null }
interface Ticket extends VncIdentity {
  origin: string | null;
  expiresAt: number;
  upstreamUrl: string;
}
export interface VncConnection {
  ticket: Ticket;
  upstream: WebSocket | null;
  client: ServerWebSocket<VncConnection> | null;
  queued: Uint8Array[];
  queuedBytes: number;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  check?: ReturnType<typeof setInterval>;
}

/** One-use grants bridge the browser's WebSocket handshake to owner authentication.
 * Neither the owner bearer token nor the VNC password appears in a socket URL.
 * The upstream address comes exclusively from the configured computer service.
 */
export class ScreenVncProxy {
  private tickets = new Map<string, Ticket>();
  private connections = new Set<VncConnection>();
  constructor(private readonly options: {
    endpoint: (botId: string) => Promise<{ url: string; password: string }>;
    authorized: (identity: VncIdentity) => Promise<boolean>;
    now?: () => number;
    recheckMs?: number;
  }) {}

  async issue(botId: string, sessionId: string | null, origin: string | null) {
    const identity = { botId, sessionId };
    if (!await this.options.authorized(identity)) throw new ApiError(403, "forbidden", "Computer access denied");
    const now = (this.options.now ?? Date.now)();
    for (const [key, value] of this.tickets) if (value.expiresAt <= now) this.tickets.delete(key);
    if (this.tickets.size >= 256) throw new ApiError(429, "too_many_requests", "Too many pending computer connections");
    const endpoint = await this.options.endpoint(botId);
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, { ...identity, origin: viewerOrigin(origin), upstreamUrl: endpoint.url, expiresAt: now + 30_000 });
    return {
      path: `/api/v0/bots/${encodeURIComponent(botId)}/screen/vnc`,
      protocols: ["openteam-vnc", `ticket.${token}`],
      password: endpoint.password,
    };
  }

  async upgrade(request: Request, server: Server<VncConnection>, botId: string): Promise<Response | undefined> {
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
    const token = protocols.find((value) => /^ticket\.[\w-]{43}$/.test(value))?.slice(7);
    const ticket = token ? this.tickets.get(token) : undefined;
    // Consume before awaiting authorization; simultaneous replay cannot succeed.
    if (token) this.tickets.delete(token);
    if (!ticket || !protocols.includes("openteam-vnc") || ticket.botId !== botId ||
      ticket.origin !== viewerOrigin(request.headers.get("origin")) || ticket.expiresAt <= (this.options.now ?? Date.now)() ||
      !await this.options.authorized(ticket)) return new Response("Computer access denied", { status: 403 });
    if ([...this.connections].filter((connection) => connection.ticket.botId === botId).length >= 3)
      return new Response("Too many computer viewers", { status: 429 });
    const data: VncConnection = { ticket, upstream: null, client: null, queued: [], queuedBytes: 0, closed: false };
    this.connections.add(data);
    if (server.upgrade(request, { data, headers: { "sec-websocket-protocol": "openteam-vnc" } })) return;
    this.connections.delete(data);
    return new Response("WebSocket upgrade required", { status: 400 });
  }

  private close = (data: VncConnection, code = 1000, reason = "Computer connection closed") => {
    if (data.closed) return;
    data.closed = true;
    clearTimeout(data.timer);
    clearInterval(data.check);
    data.queued = [];
    data.queuedBytes = 0;
    this.connections.delete(data);
    data.client?.close(code, reason);
    data.upstream?.close();
  };

  revokeSession(sessionId: string) {
    for (const [token, ticket] of this.tickets) if (ticket.sessionId === sessionId) this.tickets.delete(token);
    for (const data of this.connections) if (data.ticket.sessionId === sessionId) this.close(data, 1008, "Computer access expired");
  }

  stop() {
    this.tickets.clear();
    for (const data of this.connections) this.close(data, 1001);
  }

  readonly websocket: WebSocketHandler<VncConnection> = {
    maxPayloadLength: 1024 * 1024,
    backpressureLimit: 4 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    sendPings: true,
    open: (client) => {
      const data = client.data;
      data.client = client;
      const upstream = new WebSocket(data.ticket.upstreamUrl);
      data.upstream = upstream;
      upstream.binaryType = "arraybuffer";
      data.timer = setTimeout(() => this.close(data, 1013, "Computer connection timed out"), 10_000);
      let checking = false;
      data.check = setInterval(async () => {
        if (checking || data.closed) return;
        checking = true;
        try {
          if (!await this.options.authorized(data.ticket)) this.close(data, 1008, "Computer access expired");
        } catch { this.close(data, 1011, "Could not verify computer access"); }
        finally { checking = false; }
      }, this.options.recheckMs ?? 15_000);
      upstream.addEventListener("open", () => {
        clearTimeout(data.timer);
        if (data.closed) { upstream.close(); return; }
        for (const message of data.queued) upstream.send(message);
        data.queued = [];
        data.queuedBytes = 0;
      });
      upstream.addEventListener("message", (event) => {
        if (data.closed) return;
        if (!(event.data instanceof ArrayBuffer)) { this.close(data, 1003); return; }
        // RFB is ordered: disconnect on overflow, never drop protocol bytes.
        if (client.send(event.data) === 0) this.close(data, 1013, "Computer connection is too slow");
      });
      upstream.addEventListener("close", () => this.close(data, 1012, "Computer connection interrupted"));
      upstream.addEventListener("error", () => this.close(data, 1013, "Computer is unavailable"));
    },
    message: (client, message) => {
      const data = client.data;
      if (data.closed) return;
      if (typeof message === "string") { this.close(data, 1003); return; }
      if (data.upstream?.readyState === WebSocket.OPEN) {
        if (data.upstream.bufferedAmount + message.byteLength > 1024 * 1024) {
          this.close(data, 1013, "Computer input is congested");
          return;
        }
        data.upstream.send(message);
      } else {
        data.queuedBytes += message.byteLength;
        if (data.queuedBytes > 128 * 1024) { this.close(data, 1009); return; }
        data.queued.push(new Uint8Array(message));
      }
    },
    close: (client) => this.close(client.data),
  };
}
