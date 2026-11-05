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
  const shared = { data: "reused" };
  const fixture = {
    "10": { omitted: undefined, kept: [undefined, null, false, NaN] },
    "2": [shared, { nested: shared }],
    other: { quoted: '"東京😀\\', value: -0 },
  };
  expect([...browserJsonChunks(fixture)].join("")).toBe(JSON.stringify(fixture));
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
