import { describe, expect, test } from "bun:test";
import { VoiceMediaQueue } from "../src/services/voice-media";
import { VoiceVad } from "../src/services/voice-vad";
import { normalizeVoiceText } from "../src/services/voice-text";
import { NativeOpusCodec } from "../src/services/native-opus";

describe("voice media queue", () => {
  test("advances generations and bounds queued output", () => {
    const queue = new VoiceMediaQueue();
    queue.push(new Uint8Array([1]), 0);
    expect(queue.bufferedMs).toBe(20);
    expect(queue.currentGeneration).toBe(0);
    expect(queue.stopGeneration()).toBe(1);
    expect(queue.bufferedMs).toBe(0);
  });

  test("acknowledges frames by generation and sequence", () => {
    const queue = new VoiceMediaQueue();
    queue.push(new Uint8Array([1]), 0);
    queue.push(new Uint8Array([2]), 20);
    queue.acknowledge(0, 0);
    expect(queue.bufferedMs).toBe(20);
  });

  test("sends at most one second ahead and resumes after playback ack", () => {
    const queue = new VoiceMediaQueue();
    for (let index = 0; index < 60; index += 1) queue.push(new Uint8Array([index]), index * 20);
    expect(queue.takeSendable(0)).toHaveLength(50);
    expect(queue.takeSendable(0)).toHaveLength(0);
    queue.acknowledge(0, 0);
    expect(queue.takeSendable(queue.playbackPositionMs)).toHaveLength(1);
  });

  test("does not barge in when echo cancellation is unavailable", () => {
    const vad = new VoiceVad({ threshold: 10, startMs: 20, endSilenceMs: 100, maxTurnMs: 1000 });
    const pcm = new Int16Array(320).fill(100);
    vad.observe(pcm, false, false);
    const events = vad.observe(pcm, true, false);
    expect(events.some(event => event.type === "barge_in")).toBe(false);
  });

  test("normalizes markdown and URLs only for speech", () => {
    expect(normalizeVoiceText("**Open** https://example.com/a `code`\n```ts\nconst x = 1\n```"))
      .toBe("Open example.com/a code I sent a code block.");
  });

  test("round trips one frame through the configured native libopus", async () => {
    const codec = new NativeOpusCodec(48_000);
    try {
      const source = new Int16Array(960).fill(200);
      const packet = await codec.encode(source);
      const decoded = await codec.decode(packet);
      expect(packet.byteLength).toBeGreaterThan(0);
      expect(decoded.length).toBe(960);
    } finally {
      await codec.close();
    }
  });
});
