import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { ApiError } from "@openteam/contracts";
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  jsonBytes,
  parseJson,
  parseTarget,
  MAX_QUEUE,
  MAX_STREAMS,
  NETWORK_PROTOCOL,
  WINDOW,
  MAX_WINDOW,
  validWindow,
  LEASE_MS,
  type BrowserNetworkView,
  type NetworkRoute,
  type NetworkEgress,
  type NetworkSettings,
  type NetworkMode,
} from "@openteam/plugin-sdk/browser-network/protocol";
import type { PrismaClient } from "@openteam/db";
import type { MachineService } from "./machine-service";

function validSourceOrder(value: unknown, ranked: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 17 &&
    value.every((id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id)) &&
    new Set(value).size === value.length &&
    (!ranked || value.includes("server"))
  );
}

export interface NetworkStore {
  read(): Promise<NetworkSettings>;
  change(
    expected: number,
    mode: NetworkMode,
    machineId: string | null,
    sourceOrder?: string[]
  ): Promise<NetworkSettings | null>;
}
export function networkStore(db: PrismaClient): NetworkStore {
  const read = async (): Promise<NetworkSettings> => {
    let row = await db.browserNetworkSettings.upsert({
      where: { id: "global" },
      create: { id: "global" },
      update: {},
    });
    if (
      !["server", "device", "ranked"].includes(row.mode) ||
      (row.mode === "device" && !row.machineId) ||
      (row.mode !== "device" && row.machineId !== null) ||
      !validSourceOrder(row.sourceOrder, row.mode === "ranked") ||
      row.revision < 1 ||
      !/^[\da-f-]{36}$/i.test(row.deploymentId)
    )
      throw new Error("Invalid saved browser network settings");
    // Upgrade existing installations without losing their previously selected exit.
    while (row.mode !== "ranked") {
      const first = row.mode === "device" ? row.machineId! : "server";
      const sourceOrder = [first, ...row.sourceOrder.filter((id) => id !== first)];
      if (!sourceOrder.includes("server")) sourceOrder.push("server");
      await db.browserNetworkSettings.updateMany({
        where: { id: "global", revision: row.revision },
        data: { mode: "ranked", machineId: null, sourceOrder, revision: { increment: 1 } },
      });
      row = await db.browserNetworkSettings.findUniqueOrThrow({ where: { id: "global" } });
    }
    return {
      deploymentId: row.deploymentId,
      mode: row.mode as NetworkMode,
      sourceOrder: row.sourceOrder,
      machineId: row.machineId,
      revision: row.revision,
    };
  };
  return {
    read,
    change: async (revision, mode, machineId, sourceOrder) => {
      const result = await db.browserNetworkSettings.updateMany({
        where: { id: "global", revision },
        data: {
          mode,
          machineId,
          ...(sourceOrder ? { sourceOrder } : {}),
          revision: { increment: 1 },
        },
      });
      return result.count ? read() : null;
    },
  };
}
export interface NetworkConnection {
  kind: "browser-network";
  role: "computer" | "device";
  machineId?: string;
  request: Request;
  connectionId?: string;
  socket?: ServerWebSocket<NetworkConnection>;
  sent: number;
  received: number;
  applied: string | null;
  grantSentAt?: number;
  checkedAt: number;
  queued?: Promise<void>;
  queuedBytes?: number;
  lastLease?: number;
  availableSince?: number;
  checking?: boolean;
  controlWindow?: number;
  controlCount?: number;
  maxWindow?: number;
}
interface StreamState {
  window: number;
  ready: boolean;
  credit: [number, number];
  ended: [boolean, boolean];
}

/** One process owns the route. Every attach/source change fences the previous epoch. */
export class BrowserNetworkService {
  private computer?: NetworkConnection;
  private readonly devices = new Map<string, NetworkConnection>();
  private settings?: NetworkSettings;
  private epoch = randomUUID();
  private activeSource: string | null = null;
  private streamWindow = WINDOW;
  private readonly streams = new Map<number, StreamState>();
  private highestId = 0;
  private bytesSent = 0;
  private bytesReceived = 0;
  private blocked = 0;
  private lastRetry = -Infinity;
  private mutation: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: NetworkStore,
    private readonly machines: MachineService,
    private readonly internalAuthorized: (request: Request) => boolean,
    private readonly options: { failbackMs?: number } = {}
  ) {
    machines.onNetworkRevoke = (machineId) => this.revoke(machineId);
    this.timer = setInterval(() => {
      for (const peer of [this.computer, ...this.devices.values()]) {
        if (!peer) continue;
        // Heartbeats alone do not prove that a peer can apply the route. Start
        // this deadline with its first grant, not with every renewal.
        if (
          peer.grantSentAt !== undefined &&
          peer.applied !== this.epoch &&
          performance.now() - peer.grantSentAt >= LEASE_MS
        ) {
          this.drop(peer);
          continue;
        }
        if (
          peer.role === "device" &&
          !peer.checking &&
          performance.now() - peer.checkedAt >= 10_000
        ) {
          peer.checking = true;
          void this.validate(peer)
            .catch(() => this.drop(peer))
            .finally(() => {
              peer.checking = false;
            });
        }
      }
      this.reconcile();
    }, 250);
    this.timer.unref();
  }
  private async load() {
    const next = await this.store.read();
    // An older DB read must not undo a selection accepted while it was in flight.
    if (
      this.settings &&
      next.deploymentId === this.settings.deploymentId &&
      next.revision < this.settings.revision
    )
      return this.settings;
    const changed =
      this.settings &&
      (this.settings.deploymentId !== next.deploymentId ||
        this.settings.revision !== next.revision);
    this.settings = next;
    this.reconcile(Boolean(changed), Boolean(changed));
    return next;
  }
  private eligible(source: string) {
    if (source === "server") return true;
    const peer = this.devices.get(source);
    return !!peer && peer.lastLease !== undefined && performance.now() - peer.lastLease < LEASE_MS;
  }
  private reconcile(preferFirst = false, forceFence = false) {
    const settings = this.settings;
    if (!settings) return;
    let next: string | null = settings.mode === "server" ? "server" : settings.machineId;
    if (settings.mode === "ranked") {
      const order = settings.sourceOrder;
      const best = order.find((source) => this.eligible(source)) ?? null;
      if (
        preferFirst ||
        !this.activeSource ||
        !order.includes(this.activeSource) ||
        !this.eligible(this.activeSource)
      ) {
        next = best;
      } else {
        // Fail over immediately. Let a returning preferred computer stay online
        // for 30 seconds before switching back, so flapping links do not churn browsers.
        next =
          order.find(
            (source) =>
              this.eligible(source) &&
              (source === this.activeSource ||
                source === "server" ||
                performance.now() -
                  (this.devices.get(source)?.availableSince ?? performance.now()) >=
                  (this.options.failbackMs ?? 30_000))
          ) ?? best;
      }
    }
    const streamWindow =
      next && next !== "server"
        ? Math.min(
            MAX_WINDOW,
            this.computer?.maxWindow ?? WINDOW,
            this.devices.get(next)?.maxWindow ?? WINDOW
          )
        : WINDOW;
    if (next !== this.activeSource || forceFence || streamWindow !== this.streamWindow) {
      this.activeSource = next;
      this.streamWindow = streamWindow;
      this.fence();
    }
  }
  /** Local consent opens this authenticated channel; no owner UI call is required. */
  private registerProvider(peer: NetworkConnection) {
    const result = this.mutation.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (this.devices.get(peer.machineId!) !== peer) return;
        const settings = await this.load();
        if (settings.sourceOrder.includes(peer.machineId!)) return;
        if (settings.sourceOrder.length >= 17) return;
        const order = [...settings.sourceOrder];
        // Join the end of the computer pool, preserving an explicitly elevated server.
        const insertion =
          order.length === 1 || order.at(-1) === "server" ? order.indexOf("server") : order.length;
        order.splice(insertion, 0, peer.machineId!);
        const next = await this.store.change(settings.revision, "ranked", null, order);
        if (!next) continue;
        this.settings = next;
        this.reconcile(true, true);
        return;
      }
      throw new Error("Could not register network provider; reconnect to retry");
    });
    this.mutation = result.catch(() => {});
    return result;
  }
  private async validate(peer: NetworkConnection) {
    if (peer.role === "computer") {
      if (!this.internalAuthorized(peer.request)) throw new Error("unauthorized");
      return;
    }
    if (!this.machines.relay.matchesConnection(peer.machineId!, peer.connectionId!))
      throw new Error("stale enrollment");
    await this.machines.authenticate(peer.request);
    peer.checkedAt = performance.now();
  }
  async upgrade(
    request: Request,
    server: {
      upgrade(
        request: Request,
        options: { data: NetworkConnection; headers: Record<string, string> }
      ): boolean;
    },
    role: "computer" | "device"
  ) {
    if (
      request.headers.get("origin") ||
      request.headers.get("sec-websocket-protocol") !== NETWORK_PROTOCOL
    )
      throw new ApiError(403, "network_unauthorized", "Network channel denied");
    let machineId: string | undefined;
    if (role === "computer") {
      if (!this.internalAuthorized(request))
        throw new ApiError(401, "unauthorized", "Unauthorized");
    } else {
      machineId = (await this.machines.authenticate(request)).machineId;
      if (this.devices.size >= 16 && !this.devices.has(machineId))
        throw new ApiError(429, "network_capacity", "Too many devices");
    }
    const peer: NetworkConnection = {
      kind: "browser-network",
      role,
      machineId,
      request,
      connectionId: request.headers.get("x-openteam-connection-id") ?? undefined,
      sent: 0,
      received: 0,
      applied: null,
      checkedAt: 0,
    };
    await this.validate(peer);
    await this.load();
    if (
      server.upgrade(request, {
        data: peer,
        headers: { "sec-websocket-protocol": NETWORK_PROTOCOL },
      })
    )
      return;
    throw new ApiError(400, "network_upgrade", "WebSocket upgrade required");
  }
  private send(peer: NetworkConnection | undefined, bytes: Uint8Array) {
    const socket = peer?.socket;
    if (!socket || socket.readyState !== 1) return false;
    if (socket.getBufferedAmount() + bytes.length > MAX_QUEUE || socket.send(bytes) === 0) {
      this.drop(peer!);
      return false;
    }
    return true;
  }
  private control(peer: NetworkConnection, value: Record<string, unknown>) {
    this.send(
      peer,
      encodeFrame(FrameType.Control, 0, jsonBytes({ ...value, sequence: ++peer.sent }))
    );
  }
  private fence() {
    this.epoch = randomUUID();
    this.streams.clear();
    this.highestId = 0;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.blocked = 0;
    for (const peer of [this.computer, ...this.devices.values()])
      if (peer) {
        peer.applied = null;
        peer.grantSentAt = undefined;
        this.control(peer, { op: "invalidate" });
      }
  }
  private drop(peer: NetworkConnection) {
    if (peer !== this.computer && (!peer.machineId || this.devices.get(peer.machineId) !== peer))
      return;
    const active = peer === this.computer || peer.machineId === this.activeSource;
    if (peer === this.computer) this.computer = undefined;
    if (peer.machineId && this.devices.get(peer.machineId) === peer)
      this.devices.delete(peer.machineId);
    peer.socket?.close(1008, "Browser network connection ended");
    this.reconcile(false, active);
  }
  revoke(machineId: string) {
    const peer = this.devices.get(machineId);
    if (peer) this.drop(peer);
  }
  private route(peer: NetworkConnection): NetworkRoute {
    const settings = this.settings!;
    const machineId = this.activeSource === "server" ? null : this.activeSource;
    const selected = machineId ? this.devices.get(machineId) : undefined;
    return {
      ...settings,
      mode: this.activeSource === "server" ? "server" : "device",
      machineId,
      epoch: this.epoch,
      streamWindow: this.streamWindow,
      available:
        this.activeSource === "server"
          ? peer === this.computer
          : !!this.computer &&
            !!selected &&
            (peer === selected || (peer === this.computer && this.live(selected))),
    };
  }
  private async message(peer: NetworkConnection, bytes: Uint8Array) {
    const frame = decodeFrame(bytes);
    if (frame.type === FrameType.Control) {
      const control = parseJson(frame.payload);
      if (performance.now() - (peer.controlWindow ?? 0) > 1000) {
        peer.controlWindow = performance.now();
        peer.controlCount = 0;
      }
      if ((peer.controlCount = (peer.controlCount ?? 0) + 1) > 32)
        throw new Error("Network control rate exceeded");
      if (!Number.isSafeInteger(control.sequence) || Number(control.sequence) <= peer.received)
        throw new Error("Stale control");
      peer.received = Number(control.sequence);
      if (control.op === "lease") {
        if (typeof control.nonce !== "string" || !/^[\w-]{43}$/.test(control.nonce))
          throw new Error("Invalid nonce");
        const maxWindow = control.maxWindow ?? WINDOW;
        if (
          !validWindow(maxWindow) ||
          (peer.maxWindow !== undefined && peer.maxWindow !== maxWindow)
        )
          throw new Error("Invalid window capability");
        peer.maxWindow = maxWindow;
        await this.validate(peer);
        const current = await this.load();
        if (control.deploymentId && control.deploymentId !== current.deploymentId)
          throw new Error("Deployment identity changed");
        const now = performance.now();
        if (peer.lastLease === undefined || now - peer.lastLease >= LEASE_MS)
          peer.availableSince = now;
        peer.lastLease = now;
        if (peer.role === "device" && peer.machineId) await this.registerProvider(peer);
        this.reconcile();
        this.control(peer, { op: "lease", nonce: control.nonce, route: this.route(peer) });
        if (peer.applied !== this.epoch && peer.grantSentAt === undefined)
          peer.grantSentAt = performance.now();
      } else if (control.op === "applied") {
        if (control.epoch === this.epoch && control.revision === this.settings?.revision) {
          const firstApplied = peer.applied !== this.epoch;
          peer.applied = this.epoch;
          peer.grantSentAt = undefined;
          // Wake the broker as soon as the new exit acknowledges its route. Waiting
          // for the broker's next periodic lease adds an unnecessary renewal delay.
          if (firstApplied && peer.machineId === this.activeSource && this.computer)
            this.control(this.computer, { op: "invalidate" });
        }
      } else throw new Error("Unsupported network control");
      return;
    }
    // WebSocket ordering puts bytes already in flight before the new applied ACK.
    // Discard that fenced data without tearing down a healthy control channel.
    // After the ACK, unexpected data remains a protocol violation as before.
    if (peer.applied !== this.epoch) return;
    if (!this.activeSource || this.activeSource === "server") throw new Error("No device route");
    const device = this.devices.get(this.activeSource);
    if (
      !device ||
      !this.computer ||
      (peer !== device && peer !== this.computer) ||
      !this.live(peer)
    )
      throw new Error("Wrong route peer");
    const other = peer === device ? this.computer : device;
    if (frame.type === FrameType.Open) {
      if (peer !== this.computer || frame.id <= this.highestId) throw new Error("Invalid open");
      this.highestId = frame.id;
      const target = parseTarget(parseJson(frame.payload));
      if (
        target.epoch !== this.epoch ||
        !this.live(peer) ||
        !this.live(other) ||
        this.streams.size >= MAX_STREAMS
      ) {
        this.blocked++;
        this.send(
          peer,
          encodeFrame(FrameType.Error, frame.id, jsonBytes({ code: "device_unavailable" }))
        );
        return;
      }
      this.streams.set(frame.id, {
        ready: false,
        window: this.streamWindow,
        credit: [this.streamWindow, this.streamWindow],
        ended: [false, false],
      });
    } else {
      const stream = this.streams.get(frame.id);
      if (!stream) {
        if (frame.id <= this.highestId) return;
        throw new Error("Unknown stream");
      }
      const direction = peer === this.computer ? 0 : 1;
      if (frame.type === FrameType.Ready) {
        if (peer !== device || stream.ready || frame.payload.length)
          throw new Error("Invalid acceptance");
        stream.ready = true;
      } else if (frame.type === FrameType.Data) {
        if (
          !stream.ready ||
          stream.ended[direction] ||
          frame.payload.length > stream.credit[direction]
        )
          throw new Error("Invalid stream data");
        stream.credit[direction] -= frame.payload.length;
        if (direction === 0) this.bytesSent += frame.payload.length;
        else this.bytesReceived += frame.payload.length;
      } else if (frame.type === FrameType.Window) {
        const count = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0),
          opposite = direction === 0 ? 1 : 0;
        if (!count || stream.credit[opposite] + count > stream.window)
          throw new Error("Invalid window");
        stream.credit[opposite] += count;
      } else if (frame.type === FrameType.Fin) {
        if (!stream.ready || stream.ended[direction]) throw new Error("Invalid half close");
        stream.ended[direction] = true;
        if (stream.ended.every(Boolean)) this.streams.delete(frame.id);
      } else if (frame.type === FrameType.Reset || frame.type === FrameType.Error) {
        this.streams.delete(frame.id);
        if (frame.type === FrameType.Error) this.blocked++;
      } else throw new Error("Invalid stream operation");
    }
    this.send(other, bytes);
  }
  readonly websocket: WebSocketHandler<NetworkConnection> = {
    maxPayloadLength: 65548,
    backpressureLimit: MAX_QUEUE,
    closeOnBackpressureLimit: true,
    idleTimeout: 30,
    sendPings: true,
    open: (socket) => {
      const peer = socket.data;
      peer.socket = socket;
      if (peer.role === "computer") {
        if (this.computer) this.drop(this.computer);
        this.computer = peer;
      } else {
        const previous = this.devices.get(peer.machineId!);
        if (previous) this.drop(previous);
        this.devices.set(peer.machineId!, peer);
      }
      this.reconcile(false, peer.role === "computer" || peer.machineId === this.activeSource);
    },
    message: (socket, message) => {
      const peer = socket.data;
      // Serialize asynchronous auth/DB operations per socket to retain wire order.
      if (typeof message === "string") {
        this.drop(peer);
        return;
      }
      const bytes = new Uint8Array(message);
      peer.queuedBytes = (peer.queuedBytes ?? 0) + bytes.length;
      if (peer.queuedBytes > MAX_QUEUE) {
        this.drop(peer);
        return;
      }
      peer.queued = (peer.queued ?? Promise.resolve())
        .then(async () => {
          if (
            peer !== this.computer &&
            (!peer.machineId || this.devices.get(peer.machineId) !== peer)
          )
            return;
          await this.message(peer, bytes);
        })
        .catch(() => this.drop(peer))
        .finally(() => {
          peer.queuedBytes = (peer.queuedBytes ?? 0) - bytes.length;
        });
    },
    close: (socket) => {
      const peer = socket.data;
      if (this.computer === peer || (peer.machineId && this.devices.get(peer.machineId) === peer))
        this.drop(peer);
    },
  };
  async view(): Promise<BrowserNetworkView> {
    const settings = await this.load(),
      roster = await this.machines.list();
    const applied = !!this.computer && this.live(this.computer);
    const provider =
      this.activeSource && this.activeSource !== "server"
        ? this.devices.get(this.activeSource)
        : undefined;
    return {
      settings,
      runtime: {
        routeEpoch: this.epoch,
        state: !this.computer
          ? "update_required"
          : !applied
            ? "applying"
            : this.activeSource === "server"
              ? "server"
              : !provider
                ? "waiting_for_device"
                : !this.live(provider)
                  ? "unavailable"
                  : "ready",
        appliedRevision: applied ? settings.revision : null,
        activeMachineId: applied && provider && this.live(provider) ? this.activeSource : null,
        activeConnections: this.streams.size,
        bytesSent: this.bytesSent,
        bytesReceived: this.bytesReceived,
        blockedConnections: this.blocked,
      },
      devices: roster.map((machine) => ({
        machineId: machine.machineId,
        label: machine.label,
        enabled: machine.enabled,
        connected: machine.connected,
        sharingAllowed: this.devices.has(machine.machineId),
        supported: this.devices.has(machine.machineId),
        working: machine.enabled && this.eligible(machine.machineId),
      })),
    };
  }
  async egress<T extends Pick<NetworkEgress, "epoch" | "sourceId">>(
    probe: () => Promise<T>
  ): Promise<T> {
    await this.load();
    const epoch = this.epoch,
      source = this.activeSource;
    if (!this.computer || !this.live(this.computer) || !source || !this.eligible(source))
      throw new ApiError(503, "network_egress_unavailable", "Browser connection unavailable");
    let result: T;
    try {
      result = await probe();
    } catch {
      throw new ApiError(
        503,
        "network_egress_unavailable",
        "Could not check browser exit connection"
      );
    }
    if (
      this.epoch !== epoch ||
      result.epoch !== epoch ||
      result.sourceId !== source ||
      !this.computer ||
      !this.live(this.computer) ||
      !this.eligible(source)
    )
      throw new ApiError(
        409,
        "network_egress_changed",
        "Browser connection changed; checking again"
      );
    return result;
  }
  private live(peer: NetworkConnection) {
    return (
      peer.applied === this.epoch &&
      peer.lastLease !== undefined &&
      performance.now() - peer.lastLease < LEASE_MS
    );
  }
  update(raw: unknown) {
    const result = this.mutation.then(async () => {
      const input = raw as Record<string, unknown>;
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["expectedRevision", "mode", "machineId", "sourceOrder"].includes(k)
        ) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        !["server", "device", "ranked"].includes(String(input.mode)) ||
        (input.mode !== "device"
          ? input.machineId !== null
          : typeof input.machineId !== "string") ||
        (input.sourceOrder !== undefined &&
          !validSourceOrder(input.sourceOrder, input.mode === "ranked"))
      )
        throw new ApiError(400, "network_input_invalid", "Choose a network source");
      const settings = await this.load();
      if (settings.revision !== input.expectedRevision)
        throw new ApiError(
          409,
          "network_revision_conflict",
          "The browser connection changed. Refresh settings and try again."
        );
      let order = (input.sourceOrder ?? settings.sourceOrder) as string[];
      if (input.mode !== "ranked") {
        const first = input.mode === "server" ? "server" : (input.machineId as string);
        order = [first, ...order.filter((id) => id !== first)];
        if (!order.includes("server")) order.push("server");
      }
      if (!validSourceOrder(order, true))
        throw new ApiError(
          400,
          "network_order_invalid",
          "Rank connections with the server included once"
        );
      if (
        (input.mode === "device" ||
          (input.mode === "ranked" && order.some((id) => id !== "server"))) &&
        !this.computer
      )
        throw new ApiError(
          409,
          "network_update_required",
          "Update or reconnect the computer runtime before using a connected device."
        );
      if (input.mode === "device" && !this.devices.has(input.machineId as string))
        throw new ApiError(
          409,
          "network_device_unavailable",
          "Enable network sharing in the selected computer's desktop app first."
        );
      if (
        (input.mode === "ranked" || input.sourceOrder !== undefined) &&
        order.some(
          (id) =>
            id !== "server" &&
            !this.devices.has(id) &&
            !settings.sourceOrder.includes(id) &&
            settings.machineId !== id
        )
      )
        throw new ApiError(
          409,
          "network_device_unavailable",
          "Enable network sharing on each new ranked computer first."
        );
      if (
        settings.mode !== "ranked" ||
        settings.machineId !== null ||
        JSON.stringify(order) !== JSON.stringify(settings.sourceOrder)
      ) {
        const next = await this.store.change(settings.revision, "ranked", null, order);
        if (!next)
          throw new ApiError(
            409,
            "network_revision_conflict",
            "The browser connection changed. Refresh settings."
          );
        this.settings = next;
        this.reconcile(true, true);
      }
      return this.view();
    });
    this.mutation = result.catch(() => {});
    return result;
  }
  async retry() {
    if (performance.now() - this.lastRetry < 5000)
      throw new ApiError(429, "network_retry_limited", "Wait before retrying");
    this.lastRetry = performance.now();
    this.fence();
    return this.view();
  }
  close() {
    clearInterval(this.timer);
    for (const peer of [this.computer, ...this.devices.values()]) if (peer) this.drop(peer);
  }
}
