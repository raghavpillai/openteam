import { describe, expect, test } from "bun:test";
import { isMeaningfulTranscript } from "../src/services/voice-text";
import { PcmPreroll, VoiceVad } from "../src/services/voice-vad";

const frame = (level: number) => new Int16Array(320).fill(level); // 20 ms at 16 kHz
const feed = (vad: VoiceVad, level: number, frames: number) =>
  Array.from({ length: frames }, () => vad.observe(frame(level), false, true)).flat();

describe("voice activity gate", () => {
  test("a quiet voice below the threshold never opens a turn", () => {
    const vad = new VoiceVad();
    expect(feed(vad, 1_000, 100)).toEqual([]);
  });

  test("a short loud burst under 300 ms does not open a turn", () => {
    const vad = new VoiceVad();
    expect(feed(vad, 4_000, 12)).toEqual([]); // 240 ms
    expect(feed(vad, 0, 20)).toEqual([]);
  });

  test("speech lasting 300 ms opens a turn", () => {
    const vad = new VoiceVad();
    const events = feed(vad, 4_000, 15);
    expect(events.map((event) => event.type)).toEqual(["started"]);
  });

  test("a brief dip between syllables does not restart the start window", () => {
    const vad = new VoiceVad();
    const events = [...feed(vad, 4_000, 8), ...feed(vad, 0, 3), ...feed(vad, 4_000, 8)]; // 160 + 60 quiet + 160
    expect(events.map((event) => event.type)).toEqual(["started"]);
  });

  test("two separate bursts with a long pause never add up to a turn", () => {
    const vad = new VoiceVad();
    const events = [...feed(vad, 4_000, 10), ...feed(vad, 0, 10), ...feed(vad, 4_000, 10)];
    expect(events).toEqual([]);
  });

  test("a turn ends after 650 ms of silence", () => {
    const vad = new VoiceVad();
    feed(vad, 4_000, 20);
    expect(feed(vad, 0, 40).map((event) => event.type)).toEqual(["ended"]);
  });
});

describe("speech lead-in buffer", () => {
  test("keeps only the latest 600 ms and empties when drained", () => {
    const preroll = new PcmPreroll(600);
    for (let index = 0; index < 50; index += 1) preroll.push(frame(index));
    const drained = preroll.drain();
    expect(drained).toHaveLength(30);
    expect(drained.at(-1)![0]).toBe(49);
    expect(preroll.drain()).toEqual([]);
  });
});

describe("transcript filter", () => {
  test.each([
    ["嗯", false],
    ["嗯嗯嗯", false],
    ["啊 哦", false],
    ["uh", false],
    ["Um, hmm...", false],
    ["...", false],
    ["！", false],
    ["", false],
    ["a", false],
    ["谢", false],
    ["好", true],
    ["对", true],
    ["停", true],
    ["5", true],
    ["你好", true],
    ["现在几点了", true],
    ["ok", true],
    ["What time is it?", true],
    ["yes", true],
  ])("%j -> %p", (text, expected) => {
    expect(isMeaningfulTranscript(text)).toBe(expected);
  });
});
