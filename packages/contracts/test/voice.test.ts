import { describe, expect, test } from "bun:test";
import { decodeVoiceFrame, encodeVoiceFrame, VOICE_FRAME_HEADER_BYTES } from "../src/voice";

describe("voice binary protocol", () => {
  test("round trips an input Opus frame", () => {
    const bytes = encodeVoiceFrame({ kind: "input", version: 1, generation: 0, sequence: 7, timestampMs: 1234, payload: new Uint8Array([1, 2, 3]) });
    expect(bytes.byteLength).toBe(VOICE_FRAME_HEADER_BYTES + 3);
    expect(decodeVoiceFrame(bytes, "input")).toEqual({ kind: "input", version: 1, generation: 0, sequence: 7, timestampMs: 1234, payload: new Uint8Array([1, 2, 3]) });
  });

  test("rejects trailing bytes and a wrong direction", () => {
    const bytes = encodeVoiceFrame({ kind: "output", version: 1, generation: 2, sequence: 1, timestampMs: 0, payload: new Uint8Array([4]) });
    expect(() => decodeVoiceFrame(new Uint8Array([...bytes, 5]))).toThrow();
    expect(() => decodeVoiceFrame(bytes, "input")).toThrow();
  });
});
