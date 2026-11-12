import { expect, test } from "bun:test";
import { NetworkMux } from "../../src/browser-network/mux";
import {
  encodeFrame,
  FrameType,
  WINDOW,
  MAX_DATA,
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
