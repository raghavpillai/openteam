import type { VoiceProviderId } from "@openteam/contracts";
import type { SttEvent, StreamingStt, StreamingTts, VoiceProvider } from "../voice-provider";

const boundedText = (value: unknown) => typeof value === "string" ? value.slice(0, 8_000) : "";

export class DeepgramVoiceProvider implements VoiceProvider {
  readonly id: VoiceProviderId = "deepgram";
  constructor(private readonly options: { apiKey: string; baseUrl: string; model: string; ttsModel: string }) {}

  async stt(input: { language: string }): Promise<StreamingStt> {
    const socket = providerSocket(`${this.options.baseUrl.replace(/\/$/, "")}/v1/listen?model=${encodeURIComponent(this.options.model)}&language=${encodeURIComponent(input.language)}&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300`, this.options.apiKey);
    return new DeepgramStt(socket);
  }

  async tts(input: { language: string; voice: string }): Promise<StreamingTts> {
    // Deepgram selects its voice through the TTS model identifier. Keep the
    // historical global "alloy" default as an unset override so existing
    // Deepgram configurations continue using their configured TTS model.
    const model = input.voice && input.voice !== "alloy" ? input.voice : this.options.ttsModel;
    const socket = providerSocket(`${this.options.baseUrl.replace(/\/$/, "")}/v1/speak?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=24000`, this.options.apiKey);
    return new DeepgramTts(socket);
  }
}

const providerSocket = (url: string, apiKey: string): WebSocket => {
  const Constructor = WebSocket as unknown as { new (url: string, options?: { headers?: Record<string, string> }): WebSocket };
  return new Constructor(url, { headers: { Authorization: `Token ${apiKey}` } });
};

class DeepgramStt implements StreamingStt {
  private finalText = "";
  private closed = false;
  private listener: ((event: SttEvent) => void) | undefined;
  private opened: Promise<void> | undefined;
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as { channel?: { alternatives?: Array<{ transcript?: string }> }; is_final?: boolean; speech_final?: boolean };
        const text = boundedText(message.channel?.alternatives?.[0]?.transcript).trim();
        if (!text) return;
        const isFinal = Boolean(message.is_final || message.speech_final);
        if (isFinal) this.finalText = this.finalText ? `${this.finalText} ${text}`.slice(0, 20_000) : text;
        this.listener?.({ text, isFinal });
      } catch { /* Provider payloads are normalized at the adapter boundary. */ }
    });
  }
  onResult(listener: (event: SttEvent) => void): void { this.listener = listener; }
  async pushPcm(pcm: Int16Array): Promise<void> { if (!this.closed) { await this.open(); this.socket.send(pcm); } }
  async finish() {
    if (!this.closed) {
      await this.open();
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    return this.finalText.trim() ? { text: this.finalText } : null;
  }
  async cancel() { this.closed = true; this.socket.close(); }
  private async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.socket.readyState !== WebSocket.CONNECTING) throw new Error("Deepgram STT connection is unavailable");
    this.opened ??= new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Deepgram STT connection failed")), { once: true });
    });
    await this.opened;
  }
}

class DeepgramTts implements StreamingTts {
  private queue: Uint8Array[] = [];
  private waiting: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  private done = false;
  readonly audio: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  constructor(private readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", event => this.push(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null));
    socket.addEventListener("close", () => this.finishQueue());
  }
  async writeText(text: string) { await this.open(); this.socket.send(JSON.stringify({ type: "Speak", text })); }
  async end() { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "Flush" })); }
  async cancel() { this.finishQueue(); this.socket.close(); }
  private async open() { if (this.socket.readyState === WebSocket.CONNECTING) await new Promise<void>(resolve => this.socket.addEventListener("open", () => resolve(), { once: true })); }
  private push(value: Uint8Array | null) { if (!value?.byteLength) return; const waiter = this.waiting.shift(); if (waiter) waiter({ value, done: false }); else this.queue.push(value); }
  private finishQueue() { this.done = true; for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true }); }
  private next(): Promise<IteratorResult<Uint8Array>> { if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false }); if (this.done) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolve => this.waiting.push(resolve)); }
}
