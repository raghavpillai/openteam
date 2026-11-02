import { expect, test } from "bun:test";
import { NetworkMux } from "../../src/browser-network/mux";
import { Duplex } from "node:stream";
import {
  encodeFrame,
  FrameType,
  MAX_STREAMS,
  WINDOW,
  MAX_DATA,
  jsonBytes,
} from "../../src/browser-network/protocol";
function fixture() {
  const frames: Uint8Array[] = [];
  let closed = false;
  const mux = new NetworkMux(
    {
      send: (bytes) => frames.push(bytes),
      close: () => {
        closed = true;
      },
      bufferedAmount: 0,
    },
    { control: () => {} }
  );
  return { mux, frames, closed: () => closed };
}
test("stream capacity and teardown bound the map and release pending opens", () => {
  const { mux } = fixture();
  for (let i = 0; i < MAX_STREAMS; i++) mux.open({ host: "example.com", port: 443, epoch: "e" });
  expect(mux.streams.size).toBe(MAX_STREAMS);
  expect(() => mux.open({ host: "example.com", port: 443, epoch: "e" })).toThrow("capacity");
  mux.close();
  expect(mux.streams.size).toBe(0);
});
test("a slow consumer cannot receive beyond its advertised window", () => {
  const { mux, closed } = fixture();
  const stream = mux.open({ host: "example.com", port: 443, epoch: "e" });
  mux.receive(encodeFrame(FrameType.Ready, stream.id));
  mux.receive(encodeFrame(FrameType.Data, stream.id, new Uint8Array(MAX_DATA)));
  mux.receive(encodeFrame(FrameType.Data, stream.id, new Uint8Array(MAX_DATA)));
  expect(stream.readableLength).toBe(WINDOW);
  expect(closed()).toBe(false);
  mux.receive(encodeFrame(FrameType.Data, stream.id, new Uint8Array(1)));
  expect(closed()).toBe(true);
  expect(mux.streams.size).toBe(0);
});
test("credit controls writes and FIN follows all pending bytes", async () => {
  const { mux, frames } = fixture();
  const stream = mux.open({ host: "example.com", port: 443, epoch: "e" });
  mux.receive(encodeFrame(FrameType.Ready, stream.id));
  let finished = false;
  stream.end(Buffer.alloc(WINDOW * 2), () => (finished = true));
  expect(finished).toBe(false);
  expect(frames.filter((b) => b[1] === FrameType.Data).length).toBe(2);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, WINDOW);
  mux.receive(encodeFrame(FrameType.Window, stream.id, count));
  await Bun.sleep(0);
  expect(finished).toBe(true);
  expect(frames.filter((b) => b[1] === FrameType.Data).length).toBe(4);
  expect(frames.at(-1)![1]).toBe(FrameType.Fin);
  mux.close();
});
test("unknown stream injection and oversized credits close the transport", () => {
  const a = fixture();
  a.mux.receive(encodeFrame(FrameType.Data, 999, new Uint8Array(1)));
  expect(a.closed()).toBe(true);
  const b = fixture(),
    stream = b.mux.open({ host: "example.com", port: 443, epoch: "e" });
  b.mux.receive(encodeFrame(FrameType.Ready, stream.id));
  const credit = new Uint8Array(4);
  new DataView(credit.buffer).setUint32(0, 1);
  b.mux.receive(encodeFrame(FrameType.Window, stream.id, credit));
  expect(b.closed()).toBe(true);
});
test("a fenced incoming route accepts restarted IDs and late old dials cannot remove a new dial", async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (socket: Duplex) => void }> = [];
  const mux = new NetworkMux(
    { send() {}, close() {}, bufferedAmount: 0 },
    {
      control() {},
      dial: (_target, signal) => new Promise((resolve) => pending.push({ signal, resolve })),
    }
  );
  const open = (epoch: string) =>
    mux.receive(
      encodeFrame(FrameType.Open, 1, jsonBytes({ host: "example.com", port: 443, epoch }))
    );
  open("before");
  mux.reset();
  expect(pending[0]!.signal.aborted).toBe(true);
  open("after");
  expect(mux.closed).toBe(false);
  expect(pending).toHaveLength(2);
  const oldSocket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  pending[0]!.resolve(oldSocket);
  await Bun.sleep(0);
  expect(oldSocket.destroyed).toBe(true);
  mux.reset();
  expect(pending[1]!.signal.aborted).toBe(true);
  const newSocket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  pending[1]!.resolve(newSocket);
  await Bun.sleep(0);
  expect(newSocket.destroyed).toBe(true);
  mux.close();
});

test("chaos: a transport throwing during a write completes its callback once", async () => {
  let fail = false;
  const mux = new NetworkMux(
    {
      send() {
        if (fail) throw Error("injected transport failure");
      },
      close() {},
      bufferedAmount: 0,
    },
    { control() {} }
  );
  const stream = mux.open({ host: "example.com", port: 443, epoch: "chaos" });
  mux.receive(encodeFrame(FrameType.Ready, stream.id));
  const errors: Error[] = [];
  stream.on("error", (error) => errors.push(error));
  let callbacks = 0;
  fail = true;
  stream.write(Buffer.alloc(MAX_DATA), () => {
    callbacks++;
  });
  await Bun.sleep(10);
  expect(mux.closed).toBe(true);
  expect(mux.streams.size).toBe(0);
  expect(callbacks).toBe(1);
  expect(
    errors.some(
      (e) =>
        e.message.includes("multiple") ||
        (e as NodeJS.ErrnoException).code === "ERR_MULTIPLE_CALLBACK"
    )
  ).toBe(false);
});

test("chaos: a backward wall-clock adjustment cannot keep stream admission rate-limited", async () => {
  const original = Date.now;
  let dials = 0;
  const mux = new NetworkMux(
    { send() {}, close() {}, bufferedAmount: 0 },
    {
      control() {},
      dial: async () => {
        dials++;
        return new Duplex({
          read() {},
          write(_b, _e, done) {
            done();
          },
        });
      },
    }
  );
  try {
    Date.now = () => 100_000;
    for (let id = 1; id <= 64; id++) {
      mux.receive(
        encodeFrame(
          FrameType.Open,
          id,
          jsonBytes({ host: "example.com", port: 443, epoch: "chaos" })
        )
      );
      await Bun.sleep(0);
      mux.streams.get(id)?.destroy();
    }
    expect(dials).toBe(64);
    await Bun.sleep(1100);
    Date.now = () => 1;
    mux.receive(
      encodeFrame(FrameType.Open, 65, jsonBytes({ host: "example.com", port: 443, epoch: "chaos" }))
    );
    await Bun.sleep(0);
    expect(dials).toBe(65);
  } finally {
    Date.now = original;
    mux.close();
  }
});
