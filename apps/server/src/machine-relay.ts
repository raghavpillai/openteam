import { randomUUID } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import { HOST_BRIDGE_PATHS, HOST_TRANSFER_MAX_BYTES } from "@openteam/contracts/service-protocol";
import { spoolFile, type StagedFile } from "@openteam/plugin-sdk/file-spool";

export interface MachineRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  hasBody: boolean;
}
interface Pending {
  descriptor: MachineRequest;
  request: Request;
  staged?: StagedFile;
  dispatched: boolean;
  bodyClaimed: boolean;
  responseClaimed: boolean;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  finish: (error?: Error) => void;
  completed: Promise<void>;
  cancelResponse?: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Connection {
  id: string;
  seenAt: number;
  pending: Map<string, Pending>;
  controller: AbortController;
  staging: number;
  wake?: () => void;
}

const unavailable = () => new ApiError(409, "machine_disconnected", "The computer disconnected. An action already dispatched may have run; check its result before retrying.");
const headersForRelay = (headers: Headers) => Object.fromEntries(
  ["content-type", "content-length"].flatMap(key => headers.has(key) ? [[key, headers.get(key)!]] : [])
);

/** The desktop initiates all connections. Only request descriptors are polled;
 * uploads stage on disk and downloads stream with backpressure. Mutations are never replayed. */
export class MachineRelay {
  private readonly connections = new Map<string, Connection>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly pollMs = 20_000, private readonly presenceMs = 45_000) {
    this.timer = setInterval(() => {
      for (const [id, connection] of this.connections) {
        if (Date.now() - connection.seenAt > this.presenceMs) this.disconnect(id);
      }
    }, Math.min(10_000, presenceMs));
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    for (const id of this.connections.keys()) this.disconnect(id);
  }

  connected(machineId: string) {
    const connection = this.connections.get(machineId);
    return !!connection && Date.now() - connection.seenAt <= this.presenceMs;
  }

  connect(machineId: string) {
    this.disconnect(machineId);
    const connection: Connection = { id: randomUUID(), seenAt: Date.now(), pending: new Map(), controller: new AbortController(), staging: 0 };
    this.connections.set(machineId, connection);
    return { connectionId: connection.id };
  }

  disconnect(machineId: string, connectionId?: string) {
    const connection = this.connections.get(machineId);
    if (!connection || (connectionId && connection.id !== connectionId)) return;
    this.connections.delete(machineId);
    connection.controller.abort(unavailable());
    connection.wake?.();
    for (const pending of connection.pending.values()) pending.finish(unavailable());
  }

  private connection(machineId: string, connectionId: string) {
    const connection = this.connections.get(machineId);
    if (!connection || connection.id !== connectionId) throw unavailable();
    return connection;
  }

  async poll(machineId: string, connectionId: string, active: string[], signal: AbortSignal) {
    const connection = this.connection(machineId, connectionId);
    if (connection.wake) throw new ApiError(409, "machine_poll_busy", "A poll is already active");
    connection.seenAt = Date.now();
    if (![...connection.pending.values()].some(p => !p.dispatched) && !active.some(id => !connection.pending.has(id))) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); connection.wake = undefined; resolve(); };
        const abort = () => { finish(); reject(signal.reason); };
        const timer = setTimeout(finish, this.pollMs);
        connection.wake = finish;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    this.connection(machineId, connectionId);
    connection.seenAt = Date.now();
    const requests = [...connection.pending.values()].filter(p => !p.dispatched).slice(0, 8);
    for (const request of requests) request.dispatched = true;
    return { requests: requests.map(p => p.descriptor), cancelled: active.filter(id => !connection.pending.has(id)) };
  }

  forward(machineId: string, path: string, request: Request): Promise<Response> {
    const allowed = Object.values(HOST_BRIDGE_PATHS).some(p => path === p) || /^\/v1\/file-transfer\/[\da-f-]+$/i.test(path);
    if (!allowed || !["GET", "POST", "PUT"].includes(request.method)) throw new ApiError(400, "machine_path_invalid", "Unsupported computer operation");
    if (!this.connected(machineId)) throw unavailable();
    if (request.method === "PUT" && path.startsWith(`${HOST_BRIDGE_PATHS.transfer}/`) && request.body) {
      return this.forwardUpload(machineId, path, request);
    }
    return this.enqueue(machineId, path, request);
  }

  private async forwardUpload(machineId: string, path: string, request: Request) {
    // Drain the incoming upload to a private file before handing it to another
    // HTTP request. This avoids chained chunked-body stalls and gives the desktop
    // a verified length while keeping memory bounded for arbitrarily large files.
    const connection = this.connections.get(machineId);
    if (!connection) throw unavailable();
    if (connection.pending.size + connection.staging >= 32) throw new ApiError(429, "machine_busy", "Too many operations on this computer");
    const signal = AbortSignal.any([request.signal, connection.controller.signal]);
    connection.staging++;
    let staged: StagedFile | undefined;
    try {
      try { staged = await spoolFile(request.body!, { signal, maxBytes: HOST_TRANSFER_MAX_BYTES }); }
      finally { connection.staging--; }
      signal.throwIfAborted();
      return await this.enqueue(machineId, path, request, staged);
    } finally { await staged?.cleanup(); }
  }

  private enqueue(machineId: string, path: string, request: Request, staged?: StagedFile): Promise<Response> {
    const connection = this.connections.get(machineId);
    if (!connection || !this.connected(machineId)) throw unavailable();
    if (connection.pending.size + connection.staging >= 32) throw new ApiError(429, "machine_busy", "Too many operations on this computer");
    request.signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const id = randomUUID();
      let complete!: () => void;
      const completed = new Promise<void>(r => { complete = r; });
      const abort = () => pending.finish(unavailable());
      const pending: Pending = {
        descriptor: { id, method: request.method, path, headers: { ...headersForRelay(request.headers), ...(staged ? { "content-length": String(staged.sizeBytes) } : {}) }, hasBody: request.body !== null },
        request, staged, dispatched: false, bodyClaimed: false, responseClaimed: false, resolve, reject, completed,
        timer: setTimeout(() => pending.finish(new Error("Computer operation timed out; check its result before retrying")), 2 * 60 * 60 * 1000),
        finish: (error) => {
          if (!connection.pending.delete(id)) return;
          clearTimeout(pending.timer);
          request.signal.removeEventListener("abort", abort);
          if (error) { pending.cancelResponse?.(error); reject(error); }
          complete();
          connection.wake?.();
        },
      };
      connection.pending.set(id, pending);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      connection.wake?.();
    });
  }

  private pending(machineId: string, connectionId: string, id: string) {
    const pending = this.connection(machineId, connectionId).pending.get(id);
    if (!pending?.dispatched) throw new ApiError(410, "machine_request_gone", "This computer request is no longer active");
    return pending;
  }

  body(machineId: string, connectionId: string, id: string) {
    const pending = this.pending(machineId, connectionId, id);
    if (pending.bodyClaimed) throw new ApiError(409, "machine_body_claimed", "Request bytes were already delivered");
    pending.bodyClaimed = true;
    return new Response(pending.staged ? Bun.file(pending.staged.path) : pending.request.body, { headers: pending.descriptor.headers });
  }

  fail(machineId: string, connectionId: string, id: string) {
    this.pending(machineId, connectionId, id).finish(unavailable());
  }

  async respond(machineId: string, connectionId: string, id: string, request: Request) {
    const pending = this.pending(machineId, connectionId, id);
    if (pending.responseClaimed) throw new ApiError(409, "machine_response_claimed", "Response was already delivered");
    const status = Number(request.headers.get("x-openteam-status"));
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new ApiError(400, "machine_response_invalid", "Invalid response status");
    pending.responseClaimed = true;
    const reader = request.body?.getReader();
    const stream = reader ? new ReadableStream<Uint8Array>({
      start(controller) {
        pending.cancelResponse = error => { controller.error(error); void reader.cancel().catch(() => {}); };
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); pending.finish(); }
          else controller.enqueue(next.value);
        } catch { const error = unavailable(); controller.error(error); pending.finish(error); }
      },
      cancel() { void reader.cancel().catch(() => {}); pending.finish(unavailable()); },
    }) : null;
    const empty = [204, 205, 304].includes(status);
    pending.resolve(new Response(empty ? null : stream, { status, headers: headersForRelay(request.headers) }));
    if (!stream || empty) { void reader?.cancel().catch(() => {}); pending.finish(); }
    await pending.completed;
    return new Response(null, { status: 204 });
  }
}
