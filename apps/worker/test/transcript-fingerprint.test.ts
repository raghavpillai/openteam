import { describe, expect, test } from "bun:test";
import { TranscriptFingerprintCache, transcriptEventsFingerprint } from "../src/worker";

describe("transcript projection fingerprinting", () => {
  test("hashes transcript events deterministically", () => {
    const events = [{ id: "message:1", content: "hello" }];
    expect(transcriptEventsFingerprint(events)).toBe(transcriptEventsFingerprint(events));
    expect(transcriptEventsFingerprint(events)).not.toBe(
      transcriptEventsFingerprint([{ id: "message:1", content: "changed" }])
    );
  });

  test("expires entries and remains LRU bounded", () => {
    const cache = new TranscriptFingerprintCache(2, 100);
    cache.remember("bot-a", "a", 0);
    cache.remember("bot-b", "b", 0);
    expect(cache.matches("bot-a", "a", 1)).toBe(true);

    cache.remember("bot-c", "c", 2);
    expect(cache.size).toBe(2);
    expect(cache.matches("bot-b", "b", 3)).toBe(false);
    expect(cache.matches("bot-a", "a", 3)).toBe(true);
    expect(cache.matches("bot-a", "a", 100)).toBe(false);
  });
});
