import { describe, expect, test } from "bun:test";
import { decodeVoiceFrame } from "@openteam/contracts";
import { VoiceSessionConnection } from "../src/services/voice-session";

const connection = () =>
  new VoiceSessionConnection({
    sessionId: "session",
    onHello: async () => undefined,
    onControl: async () => undefined,
    onInputFrame: async () => undefined,
    onClose: async () => undefined,
  });

/**
 * Clients drop every output frame whose generation is <= the generation reported by
 * barge_in / audio.stopped. So the reported value must be the generation that was
 * stopped, and audio produced afterwards must carry a strictly greater one.
 */
describe("output generation after a stop", () => {
  test("audio after a barge-in is not at or below the stopped generation", () => {
    const call = connection();
    const stopped = call.stopOutputGeneration();
    const frame = decodeVoiceFrame(call.media.push(new Uint8Array([1]), 0), "output");
    expect(frame.generation).toBeGreaterThan(stopped);
  });

  test("every later reply stays audible after repeated barge-ins", () => {
    const call = connection();
    for (let index = 0; index < 4; index += 1) {
      const stopped = call.stopOutputGeneration();
      const frame = decodeVoiceFrame(call.media.push(new Uint8Array([index]), 0), "output");
      expect(frame.generation).toBeGreaterThan(stopped);
    }
  });

  test("frames queued before the stop are at or below the reported generation", () => {
    const call = connection();
    const before = decodeVoiceFrame(call.media.push(new Uint8Array([1]), 0), "output");
    const stopped = call.stopOutputGeneration();
    expect(before.generation).toBeLessThanOrEqual(stopped);
  });
});
