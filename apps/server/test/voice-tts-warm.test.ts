import { describe, expect, test } from "bun:test";
import type { StreamingTts } from "../src/services/voice-provider";
import { WarmTtsPool } from "../src/services/voice-tts-warm";

const fakeStream = (id: number, log: string[]): StreamingTts => ({
  writeText: async () => undefined,
  end: async () => undefined,
  cancel: async () => void log.push(`cancel:${id}`),
  audio: {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  },
});

const pool = (options: { failFirst?: boolean; ttlMs?: number } = {}) => {
  const log: string[] = [];
  let opened = 0;
  const instance = new WarmTtsPool(async () => {
    const id = ++opened;
    log.push(`open:${id}`);
    if (options.failFirst && id === 1) throw new Error("handshake failed");
    return fakeStream(id, log);
  }, options.ttlMs);
  return { instance, log, opened: () => opened };
};

describe("warm TTS connection", () => {
  test("hands out the connection opened ahead of time and warms the next", async () => {
    const { instance, log } = pool();
    instance.warm();
    const first = await instance.take();
    expect(first.warmed).toBe(true);
    expect(log).toEqual(["open:1", "open:2"]);
    instance.close();
  });

  test("opens a cold connection when nothing was warmed", async () => {
    const { instance } = pool();
    const taken = await instance.take();
    expect(taken.warmed).toBe(false);
    instance.close();
  });

  test("a failed warm-up falls back to a fresh connection without surfacing the error", async () => {
    const { instance, opened } = pool({ failFirst: true });
    instance.warm();
    const taken = await instance.take();
    expect(taken.warmed).toBe(false);
    expect(opened()).toBeGreaterThanOrEqual(2);
    instance.close();
  });

  test("an unused connection is closed after its time to live", async () => {
    const { instance, log } = pool({ ttlMs: 20 });
    instance.warm();
    await Bun.sleep(60);
    expect(log).toContain("cancel:1");
    instance.close();
  });

  test("close cancels a waiting connection and stops warming", async () => {
    const { instance, log, opened } = pool();
    instance.warm();
    instance.close();
    await Bun.sleep(10);
    expect(log).toContain("cancel:1");
    instance.warm();
    expect(opened()).toBe(1);
  });
});
