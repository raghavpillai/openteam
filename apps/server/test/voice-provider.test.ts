import { describe, expect, test } from "bun:test";
import type { StreamingStt, StreamingTts, VoiceProvider } from "../src/services/voice-provider";

class TestStt implements StreamingStt {
  private received = 0;
  async pushPcm(pcm: Int16Array): Promise<void> {
    this.received += pcm.length;
  }
  async finish() {
    return this.received > 0 ? { text: "Voice transport test turn", language: "en-US" } : null;
  }
  async cancel(): Promise<void> {
    this.received = 0;
  }
  onResult(_listener: (event: { text: string; isFinal: boolean; language?: string }) => void): void {}
}

class TestTts implements StreamingTts {
  private text = "";
  private chunks: Uint8Array[] = [];
  private waiting: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  private done = false;
  readonly audio: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };

  async writeText(text: string): Promise<void> {
    this.text += text;
  }

  async end(): Promise<void> {
    const sampleRate = 24_000;
    const samples = Math.min(sampleRate, Math.max(4_800, this.text.length * 120));
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < samples; index += 1) {
      const envelope = Math.min(1, index / 240) * Math.min(1, (samples - index) / 2_400);
      view.setInt16(index * 2, Math.round(Math.sin(index / 3.7) * 3_000 * envelope), true);
    }
    this.push(pcm);
    this.done = true;
    this.finishWaiters();
  }

  async cancel(): Promise<void> {
    this.done = true;
    this.chunks = [];
    this.finishWaiters();
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.chunks.length) return Promise.resolve({ value: this.chunks.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private push(chunk: Uint8Array) {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else this.chunks.push(chunk);
  }

  private finishWaiters() {
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }
}

class TestVoiceProvider implements VoiceProvider {
  readonly id = "volcengine" as const;
  async stt(_input: { language: string }): Promise<StreamingStt> {
    return new TestStt();
  }
  async tts(_input: { language: string; voice: string }): Promise<StreamingTts> {
    return new TestTts();
  }
}

describe("voice provider interfaces", () => {
  test("accept a deterministic streaming STT fixture", async () => {
    const stt = await new TestVoiceProvider().stt({ language: "en-US" });
    await stt.pushPcm(new Int16Array(320));
    expect(await stt.finish()).toMatchObject({ text: "Voice transport test turn" });
  });

  test("produce bounded PCM output for playback fixtures", async () => {
    const tts = await new TestVoiceProvider().tts({ language: "en-US", voice: "fixture" });
    await tts.writeText("hello");
    await tts.end();
    let bytes = 0;
    for await (const chunk of tts.audio) bytes += chunk.byteLength;
    expect(bytes).toBeGreaterThanOrEqual(9_600);
    expect(bytes).toBeLessThanOrEqual(48_000);
  });
});

describe("Volcengine handshake errors", () => {
  const failure = async (message: string) => {
    const { connectionFailure } = await import("../src/services/voice-providers/volcengine");
    return connectionFailure("ASR", { message } as unknown as Event);
  };

  test("reports the actual status, not the expected 101", async () => {
    const text = await failure("WebSocket connection to 'wss://x' failed: Expected 101 status code: 401");
    expect(text).toContain("rejected the credentials (HTTP 401)");
    expect(text).not.toContain("101");
  });

  test("falls back to a generic message without a status", async () => {
    expect(await failure("socket hang up")).toBe("Volcengine ASR connection failed");
  });
});
