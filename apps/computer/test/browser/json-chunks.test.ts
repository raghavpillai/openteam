import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { browserJsonChunks, browserJsonExceeds } from "../../src/browser/json-chunks";
import { stateDigest } from "../../src/browser/origin-state";

test("chunked browser JSON preserves escaping, UTF-8 and surrogate boundaries", () => {
  const strings = [
    "",
    '"\\\b\f\n\r\t\u0000',
    "café 東京 😀 \ud800 lone \udfff",
    "x".repeat(16383) + "😀" + "y".repeat(16383) + "😀",
    "\u0001".repeat(200_000),
    "x".repeat(2_000_000),
  ];
  for (const value of strings) {
    const fixture = { [value]: [value, null, false, 0, -0, NaN, Infinity, undefined] };
    const expected = JSON.stringify(fixture);
    const chunks = [...browserJsonChunks(fixture)];
    expect(chunks.join("")).toBe(expected);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe(expected);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(6 * 16384);
    expect(browserJsonExceeds(fixture, expected.length)).toBeFalse();
    expect(browserJsonExceeds(fixture, expected.length - 1)).toBeTrue();
  }
});

test("plain nested data matches native JSON ordering and omission semantics", () => {
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const value = (depth: number): unknown => {
    const kind = Math.floor(random() * (depth ? 8 : 5));
    switch (kind) {
      case 0: return undefined;
      case 1: return null;
      case 2: return random() > 0.5;
      case 3: return random() * 1e20;
      case 4: return `value " 東京 😀 \\ ${String.fromCharCode(random() * 65536)}`;
      case 5: return Array.from({ length: 7 }, () => value(depth - 1));
      default: return Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`key${i}`, value(depth - 1)]));
    }
  };
  for (let i = 0; i < 100; i++) {
    const fixture = { "10": value(3), "2": value(3), other: value(3) };
    expect([...browserJsonChunks(fixture)].join("")).toBe(JSON.stringify(fixture));
  }
  const shared = { data: "reused" };
  expect([...browserJsonChunks({ a: shared, b: shared })].join(""))
    .toBe(JSON.stringify({ a: shared, b: shared }));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => [...browserJsonChunks(cyclic)]).toThrow("Circular browser state");
});

test("incremental digest is identical to the previous whole-string hash", () => {
  const state = {
    origin: "https://fixture.invalid",
    capturedAt: "ignored",
    localStorage: [["large", "x".repeat(16383) + "😀".repeat(100_000)]] as Array<[string, string]>,
    cacheStorage: [{ nested: { body: "A".repeat(1_000_000) } }],
  };
  expect(stateDigest(state)).toBe(createHash("sha256")
    .update(JSON.stringify({ ...state, capturedAt: undefined })).digest("hex"));
});
