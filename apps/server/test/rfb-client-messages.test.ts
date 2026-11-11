import { expect, test } from "bun:test";
import { RfbClientMessages } from "../src/rfb-client-messages";
const handshake = Buffer.concat([
  Buffer.from("RFB 003.008\n"),
  Buffer.from([2]),
  Buffer.alloc(16, 5),
  Buffer.from([1]),
]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
const frame = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
test("fragments and coalesced input cannot hide behind view-only messages", () => {
  const parser = new RfbClientMessages();
  const bytes = Buffer.concat([handshake, frame, key, frame]);
  const packets = [];
  for (const byte of bytes) packets.push(...parser.push(Buffer.from([byte])));
  expect(packets.map((p) => p.input)).toEqual([false, false, false, false, false, true, false]);
  expect(Buffer.concat(packets.map((p) => p.data))).toEqual(bytes);
});
test("QEMU keys, clipboard, resize, and extended pointer operations are gated", () => {
  const parser = new RfbClientMessages();
  parser.push(handshake);
  const packets = parser.push(
    Buffer.concat([
      Buffer.from([255, 0, 0, 1, 0, 0, 0, 97, 0, 0, 0, 30]),
      Buffer.from([6, 0, 0, 0, 255, 255, 255, 252, 0, 0, 0, 0]),
      Buffer.from([251, 0, 5, 0, 3, 32, 0, 0]),
      Buffer.from([5, 128, 0, 0, 0, 0, 1]),
    ])
  );
  expect(packets.map((p) => p.input)).toEqual([true, true, true, true]);
});
test("unrecognized messages and excessive clipboard lengths fail closed", () => {
  const p = new RfbClientMessages();
  p.push(handshake);
  expect(() => p.push(Buffer.from([42]))).toThrow();
  const q = new RfbClientMessages();
  q.push(handshake);
  expect(() => q.push(Buffer.from([6, 0, 0, 0, 127, 255, 255, 255]))).toThrow();
});
