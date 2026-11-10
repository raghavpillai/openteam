import { Duplex, type DuplexOptions } from "node:stream";
import { NetworkError } from "./policy";
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  jsonBytes,
  parseJson,
  parseTarget,
  MAX_DATA,
  MAX_QUEUE,
  MAX_STREAMS,
  WINDOW,
  validWindow,
  type OpenTarget,
} from "./protocol";

export interface Wire {
  send(bytes: Uint8Array): void;
  close(): void;
  bufferedAmount: number;
}
type Write = { bytes: Buffer; offset: number; done: (error?: Error | null) => void };

/** A bounded byte stream. TCP pipe backpressure controls receive-window replenishment. */
export class NetworkStream extends Duplex {
  private credit = 0;
  private receiveCredit: number;
  private consumed = 0;
  private pending?: Write;
  private accepted = false;
  private remoteEnded = false;
  private quiet = false;
  private accept!: () => void;
  private refuse!: (error: Error) => void;
  readonly ready: Promise<void>;
  constructor(
    readonly id: number,
    private readonly mux: NetworkMux,
    private readonly window: number,
    options: DuplexOptions = {}
  ) {
    super({ ...options, allowHalfOpen: true, highWaterMark: 32 * 1024 });
    this.receiveCredit = window;
    this.ready = new Promise((resolve, reject) => {
      this.accept = resolve;
      this.refuse = reject;
    });
    void this.ready.catch(() => {});
    this.on("error", () => {}); // The pipe owner also observes errors; never crash a host process.
  }
  markReady() {
    if (this.accepted) throw new Error("Duplicate stream acknowledgement");
    this.accepted = true;
    this.credit = this.window;
    this.accept();
    this.flush();
  }
  private flush() {
    const pending = this.pending;
    if (!pending || !this.accepted || this.destroyed) return;
    while (pending.offset < pending.bytes.length && this.credit > 0) {
      const length = Math.min(MAX_DATA, this.credit, pending.bytes.length - pending.offset);
      this.credit -= length;
      this.mux.send(
        FrameType.Data,
        this.id,
        pending.bytes.subarray(pending.offset, pending.offset + length)
      );
      pending.offset += length;
    }
    if (pending.offset === pending.bytes.length) {
      this.pending = undefined;
      pending.done();
    }
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.pending = { bytes, offset: 0, done };
    this.flush();
  }
  private replenish() {
    if (!this.consumed || this.destroyed) return;
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, this.consumed);
    this.receiveCredit += this.consumed;
    this.consumed = 0;
    this.mux.send(FrameType.Window, this.id, bytes);
  }
  override _read() {
    this.replenish();
  }
  override _final(done: (error?: Error | null) => void) {
    this.mux.send(FrameType.Fin, this.id);
    done();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    this.refuse(error ?? new NetworkError("device_unavailable"));
    const pending = this.pending;
    this.pending = undefined;
    pending?.done(error ?? new NetworkError("device_unavailable"));
    this.mux.remove(this.id);
    if (!this.quiet && !(this.remoteEnded && this.writableFinished))
      this.mux.send(FrameType.Reset, this.id, jsonBytes({ code: "stream_closed" }));
    done(error);
  }
  reset(error: Error) {
    this.quiet = true;
    this.destroy(error);
  }
  receive(type: FrameType, payload: Uint8Array) {
    if (type === FrameType.Ready) {
      if (payload.length !== 0) throw new Error("Invalid ready frame");
      this.markReady();
      return;
    }
    if (type === FrameType.Error || type === FrameType.Reset) {
      const { code } = parseJson(payload);
      this.reset(
        new NetworkError(
          typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "connect_failed"
        )
      );
      return;
    }
    if (!this.accepted) throw new Error("Data before stream acceptance");
    if (type === FrameType.Data) {
      if (this.remoteEnded || payload.length > this.receiveCredit)
        throw new Error("Stream receive window exceeded");
      this.receiveCredit -= payload.length;
      this.consumed += payload.length;
      if (this.push(Buffer.from(payload))) this.replenish();
    } else if (type === FrameType.Window) {
      const count = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
      if (!count || this.credit + count > this.window) throw new Error("Invalid stream credit");
      this.credit += count;
      this.flush();
    } else if (type === FrameType.Fin) {
      if (this.remoteEnded) throw new Error("Duplicate FIN");
      this.remoteEnded = true;
      this.push(null);
    } else throw new Error("Invalid stream frame");
  }
}

export class NetworkMux {
  private window = WINDOW;
  configureWindow(window: number) {
    if (!validWindow(window)) throw new Error("Invalid stream window");
    if (window === this.window) return;
    if (this.streams.size || this.dials.size) throw new Error("Window changed on an active route");
    this.window = window;
  }
  readonly streams = new Map<number, NetworkStream>();
  private nextId = 1;
  private highestIncoming = 0;
  private readonly dials = new Map<number, AbortController>();
  private openedAt = 0;
  private openCount = 0;
  closed = false;
  private sequence = 0;
  private receivedSequence = 0;
  constructor(
    private readonly wire: Wire,
    private readonly options: {
      control: (message: Record<string, unknown>) => void;
      dial?: (target: OpenTarget, signal: AbortSignal) => Promise<Duplex>;
      changed?: () => void;
    }
  ) {}
  send(type: FrameType, id: number, payload?: Uint8Array) {
    if (this.closed) return;
    if (this.retainedBytes() + (payload?.byteLength ?? 0) + 12 > MAX_QUEUE) {
      this.close();
      return;
    }
    try {
      this.wire.send(encodeFrame(type, id, payload));
    } catch {
      this.close();
    }
  }
  private retainedBytes() {
    let bytes = this.wire.bufferedAmount;
    for (const stream of this.streams.values())
      bytes += stream.readableLength + stream.writableLength;
    return bytes;
  }
  control(message: Record<string, unknown>) {
    this.send(FrameType.Control, 0, jsonBytes({ ...message, sequence: ++this.sequence }));
  }
  open(target: OpenTarget): NetworkStream {
    if (this.closed || this.streams.size >= MAX_STREAMS || this.nextId >= 0xfffffff0)
      throw new NetworkError("capacity_exceeded");
    const stream = this.create(this.nextId++);
    this.send(FrameType.Open, stream.id, jsonBytes(target));
    return stream;
  }
  private create(id: number) {
    const stream = new NetworkStream(id, this, this.window);
    this.streams.set(id, stream);
    this.options.changed?.();
    const timer = setTimeout(() => stream.destroy(new NetworkError("connect_timeout")), 15_000);
    timer.unref?.();
    void stream.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer)
    );
    return stream;
  }
  remove(id: number) {
    this.dials.get(id)?.abort();
    this.dials.delete(id);
    this.streams.delete(id);
    this.options.changed?.();
  }
  receive(bytes: Uint8Array) {
    try {
      if (this.retainedBytes() + bytes.length > MAX_QUEUE)
        throw new Error("Network buffer budget exceeded");
      const frame = decodeFrame(bytes);
      if (frame.type === FrameType.Control) {
        const message = parseJson(frame.payload);
        if (
          !Number.isSafeInteger(message.sequence) ||
          Number(message.sequence) <= this.receivedSequence
        )
          throw new Error("Stale control message");
        this.receivedSequence = Number(message.sequence);
        this.options.control(message);
        return;
      }
      if (frame.type === FrameType.Open) {
        if (!this.options.dial || frame.id <= this.highestIncoming)
          throw new Error("Invalid stream open");
        this.highestIncoming = frame.id;
        if (performance.now() - this.openedAt >= 1000) {
          this.openedAt = performance.now();
          this.openCount = 0;
        }
        if (this.streams.size >= MAX_STREAMS || this.dials.size >= 16 || ++this.openCount > 64) {
          this.send(FrameType.Error, frame.id, jsonBytes({ code: "capacity_exceeded" }));
          return;
        }
        const target = parseTarget(parseJson(frame.payload));
        const stream = this.create(frame.id),
          controller = new AbortController();
        this.dials.set(frame.id, controller);
        void this.options.dial(target, controller.signal).then(
          (socket) => {
            if (this.dials.get(frame.id) === controller) this.dials.delete(frame.id);
            if (stream.destroyed || this.closed || controller.signal.aborted) {
              socket.destroy();
              return;
            }
            if (socket.destroyed) {
              this.send(FrameType.Error, frame.id, jsonBytes({ code: "connect_failed" }));
              stream.reset(new NetworkError("connect_failed"));
              return;
            }
            stream.markReady();
            this.send(FrameType.Ready, frame.id);
            const idle = () => {
              if ("setTimeout" in socket)
                (socket as import("node:net").Socket).setTimeout(30 * 60_000, () =>
                  stream.destroy()
                );
            };
            idle();
            socket.on("error", () => stream.destroy(new NetworkError("connect_failed")));
            stream.once("close", () => socket.destroy());
            socket.once("close", () => {
              if (!socket.readableEnded) stream.destroy(new NetworkError("connect_failed"));
            });
            socket.pipe(stream).pipe(socket);
          },
          (error) => {
            if (stream.destroyed) return;
            this.send(
              FrameType.Error,
              frame.id,
              jsonBytes({ code: error instanceof NetworkError ? error.code : "connect_failed" })
            );
            stream.reset(new NetworkError("connect_failed"));
          }
        );
      } else {
        const stream = this.streams.get(frame.id);
        if (stream) stream.receive(frame.type, frame.payload);
        else if (frame.id > Math.max(this.highestIncoming, this.nextId - 1))
          throw new Error("Unknown network stream");
      }
    } catch {
      this.close();
    }
  }
  reset() {
    for (const stream of [...this.streams.values()])
      stream.reset(new NetworkError("device_unavailable"));
    // Incoming IDs belong to the fenced route: a replacement computer starts
    // at 1 even when this device's WebSocket survives. Keep our outgoing IDs
    // monotonic so delayed callbacks on this transport cannot reuse them.
    this.highestIncoming = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.reset();
    this.wire.close();
  }
}
