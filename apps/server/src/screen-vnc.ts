import { RfbClientMessages } from "./rfb-client-messages";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { randomBytes } from "node:crypto";
import { ApiError } from "@openteam/contracts";

// Packaged Electron omits Origin on some fetches (or uses "null"), but sends
// "file://" for WebSocket. These are opaque/native origins. HTTP origins stay
// exact; every connection still requires its one-use authenticated ticket.
const viewerOrigin = (origin: string | null) => origin === "file://" || origin === "null" ? null : origin;

const ACTIVITY_REPORT_MS = 5_000;

export interface VncIdentity { botId: string; sessionId: string | null; controlId?: string; generation?: number }
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
  /** The RFB handshake finished: the client has sent its first FramebufferUpdateRequest. */
  ready?: boolean;
  parser?: RfbClientMessages;
  forwarding?: Promise<void>;
  pendingInputBytes?: number;
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
    /** Called at most once per ACTIVITY_REPORT_MS per bot while a client sends key, pointer or clipboard input. */
    onActivity?: (botId: string) => void;
    mayInput?: (identity: VncIdentity) => Promise<boolean>;
  }) {}
  private lastActivity = new Map<string, number>();

  /**
   * RFB client messages 4 (KeyEvent), 5 (PointerEvent) and 6 (ClientCutText) are user input.
   * Only messages after the first FramebufferUpdateRequest (3) count, because handshake bytes
   * such as the password response are arbitrary. A viewer in observation mode sends none of them.
   */
  private noteInput = (data: VncConnection, message: Uint8Array) => {
    const type = message[0];
    if (type === 3) data.ready = true;
    if (!data.ready || (type !== 4 && type !== 5 && type !== 6)) return;
    const now = (this.options.now ?? Date.now)();
    const botId = data.ticket.botId;
    if (now - (this.lastActivity.get(botId) ?? 0) < ACTIVITY_REPORT_MS) return;
    this.lastActivity.set(botId, now);
    this.options.onActivity?.(botId);
  };

  async issue(botId: string, sessionId: string | null, origin: string | null, control?: { controlId?: string; generation?: number }) {
    const identity = { botId, sessionId, ...control };
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
      const forward = (bytes: Uint8Array) => {
        if (data.closed) return;
        if (data.upstream?.readyState === WebSocket.OPEN) {
          if (data.upstream.bufferedAmount + bytes.byteLength > 1024 * 1024) {
            this.close(data, 1013, "Computer input is congested"); return;
          }
          data.upstream.send(bytes);
        } else {
          data.queuedBytes += bytes.byteLength;
          if (data.queuedBytes > 128 * 1024) { this.close(data, 1013); return; }
          data.queued.push(bytes);
        }
      };
      if (!this.options.mayInput) {
        this.noteInput(data, message);
        forward(message);
        return;
      }
      try {
        const packets = (data.parser ??= new RfbClientMessages()).push(message);
        data.pendingInputBytes = (data.pendingInputBytes ?? 0) + message.byteLength;
        if (data.pendingInputBytes > 1024 * 1024) { this.close(data, 1013); return; }
        data.forwarding = (data.forwarding ?? Promise.resolve()).then(async () => {
          for (const packet of packets) {
            if (data.closed) return;
            if (packet.input && !await this.options.mayInput!(data.ticket)) {
              // Keep the framebuffer stream alive; rejected input is never replayed.
              continue;
            }
            if (packet.input && !data.ticket.controlId) { data.ready = true; this.noteInput(data, packet.data); }
            forward(packet.data);
          }
        }).catch(() => this.close(data, 1013, "Could not verify computer control"))
          .finally(() => { data.pendingInputBytes = (data.pendingInputBytes ?? 0) - message.byteLength; });
      } catch { this.close(data, 1003, "Invalid computer input"); }
    },
    close: (client) => this.close(client.data),
  };
}
