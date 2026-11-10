import type { VoiceProviderId } from "@openteam/contracts";
import type { SttEvent, StreamingStt, StreamingTts, VoiceProvider } from "../voice-provider";

interface VolcengineOptions {
  apiKey: string;
  baseUrl: string;
  sttUrl: string;
  ttsUrl: string;
  sttResourceId: string;
  ttsResourceId: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
}

export class VolcengineVoiceProvider implements VoiceProvider {
  readonly id: VoiceProviderId = "volcengine";
  constructor(private readonly options: VolcengineOptions) {}

  async stt(input: { language: string }): Promise<StreamingStt> {
    const socket = providerSocket(this.options.sttUrl || `${this.options.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/v3/sauc/bigmodel_async`, {
      "X-Api-Key": this.options.apiKey,
      "X-Api-Resource-Id": this.options.sttResourceId,
      "X-Api-Request-Id": crypto.randomUUID(),
      "X-Api-Sequence": "-1",
      "X-Api-Connect-Id": crypto.randomUUID(),
    });
    return new VolcengineStt(socket);
  }

  async tts(input: { language: string; voice: string }): Promise<StreamingTts> {
    const socket = providerSocket(this.options.ttsUrl || `${this.options.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/v3/tts/unidirectional/stream`, {
      "X-Api-Key": this.options.apiKey,
      "X-Api-Resource-Id": this.options.ttsResourceId,
      "X-Api-Request-Id": crypto.randomUUID(),
    });
    return new VolcengineTts(socket, input.language, input.voice || this.options.voice, this.options.ttsModel);
  }
}

const STT_FINAL_TIMEOUT_MS = 3_000;

const providerSocket = (url: string, headers: Record<string, string>): WebSocket => {
  const Constructor = WebSocket as unknown as { new (url: string, options?: { headers?: Record<string, string> }): WebSocket };
  return new Constructor(url, { headers });
};

/** Turns the WebSocket handshake failure into an actionable message without echoing credentials. */
export const connectionFailure = (service: "ASR" | "TTS", event: Event): string => {
  const detail = (event as { message?: unknown }).message;
  const status = typeof detail === "string" ? /status code:\s*(\d{3})/i.exec(detail)?.[1] : undefined;
  if (status === "401" || status === "403") {
    return `Volcengine ${service} rejected the credentials (HTTP ${status}). Check the API key and that the ${service} resource ID is enabled for it in voice settings`;
  }
  return `Volcengine ${service} connection failed${status ? ` (HTTP ${status})` : ""}`;
};

class VolcengineStt implements StreamingStt {
  private listener: ((event: SttEvent) => void) | undefined;
  private finalText = "";
  private opened: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private error: Error | undefined;
  private completed: Promise<void>;
  private markCompleted!: () => void;

  constructor(private readonly socket: WebSocket) {
    this.completed = new Promise<void>(resolve => { this.markCompleted = resolve; });
    socket.addEventListener("message", event => this.handle(event.data));
    socket.addEventListener("close", () => this.markCompleted());
  }

  onResult(listener: (event: SttEvent) => void): void { this.listener = listener; }

  async pushPcm(pcm: Int16Array): Promise<void> {
    await this.open();
    if (!this.started) {
      this.socket.send(volcengineFrame(1, 0, 1, new TextEncoder().encode(JSON.stringify({
        user: { uid: "openteam-voice" },
        audio: { format: "pcm", codec: "raw", rate: 16_000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          enable_ddc: true,
          show_utterances: true,
          enable_nonstream: true,
          result_type: "full",
        },
      }))));
      this.started = true;
    }
    this.socket.send(volcengineFrame(2, 0, 0, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
  }

  async finish(): Promise<{ text: string } | null> {
    if (!this.closed) {
      await this.open();
      if (this.started) {
        this.socket.send(volcengineFrame(2, 2, 0, new Uint8Array(0)));
        // The server answers the last audio packet with a final result (flag 0x2); cap the wait so a stalled provider cannot hang the turn.
        await Promise.race([this.completed, new Promise(resolve => setTimeout(resolve, STT_FINAL_TIMEOUT_MS))]);
      }
    }
    if (this.error && !this.finalText.trim()) throw this.error;
    return this.finalText.trim() ? { text: this.finalText.trim() } : null;
  }

  async cancel(): Promise<void> {
    this.closed = true;
    this.socket.close();
  }

  private async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.socket.readyState !== WebSocket.CONNECTING) throw new Error("Volcengine ASR connection is unavailable");
    this.opened ??= new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", event => reject(new Error(connectionFailure("ASR", event))), { once: true });
    });
    await this.opened;
  }

  private handle(value: unknown): void {
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.byteLength >= 8 && bytes[1]! >> 4 === 15) { this.error = new Error(`Volcengine ASR: ${errorFrameMessage(bytes)}`); this.markCompleted(); return; }
    if (bytes.byteLength < 8 || bytes[1]! >> 4 !== 9) return;
    const flags = bytes[1]! & 0x0f;
    const serialization = bytes[2]! >> 4;
    // Flags bit 0 means a 4-byte sequence precedes the payload size; bit 1 marks the last packet.
    const sizeOffset = flags & 0x1 ? 8 : 4;
    if (bytes.byteLength < sizeOffset + 4) return;
    const payloadSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(sizeOffset);
    const payload = bytes.slice(sizeOffset + 4, sizeOffset + 4 + payloadSize);
    const last = (flags & 0x2) !== 0;
    try {
      if (serialization !== 1) return;
      const message = JSON.parse(new TextDecoder().decode(payload)) as { result?: { text?: string; utterances?: Array<{ text?: string; definite?: boolean }> } };
      const result = message.result;
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      if (!text) return;
      const definite = last || Boolean(result?.utterances?.some(item => item.definite));
      if (definite) this.finalText = text;
      this.listener?.({ text, isFinal: definite });
    } catch { /* Provider payloads stay inside the adapter boundary. */ } finally {
      if (last) this.markCompleted();
    }
  }
}

class VolcengineTts implements StreamingTts {
  private text = "";
  private opened: Promise<void> | undefined;
  private queue: Uint8Array[] = [];
  private waiting: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  private done = false;
  private failure: Error | undefined;
  private rejecting: Array<(reason: Error) => void> = [];
  readonly audio: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };

  constructor(private readonly socket: WebSocket, private readonly language: string, private readonly voice: string, private readonly model: string) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", event => this.handle(event.data));
    socket.addEventListener("close", () => this.finishQueue());
  }

  async writeText(text: string): Promise<void> { this.text += text; }

  async end(): Promise<void> {
    await this.open();
    const payload = new TextEncoder().encode(JSON.stringify({
      user: { uid: "openteam-voice" },
      req_params: {
        text: this.text,
        speaker: this.voice,
        model: this.model || undefined,
        audio_params: { format: "pcm", sample_rate: 24_000 },
        additions: JSON.stringify({ enable_language_detector: true, explicit_language: this.language, disable_markdown_filter: false }),
      },
    }));
    this.socket.send(volcengineFrame(1, 0, 1, payload));
  }

  async cancel(): Promise<void> { this.finishQueue(); this.socket.close(); }

  private async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.socket.readyState !== WebSocket.CONNECTING) throw new Error("Volcengine TTS connection is unavailable");
    this.opened ??= new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", event => reject(new Error(connectionFailure("TTS", event))), { once: true });
    });
    await this.opened;
  }

  private handle(value: unknown): void {
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.byteLength < 8) return;
    const type = bytes[1]! >> 4;
    if (type === 15) { this.fail(errorFrameMessage(bytes)); return; }
    const event = bytes.byteLength >= 8 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4) : 0;
    if (type !== 11 || event !== 352) {
      if (event === 152) this.finishQueue();
      return;
    }
    let offset = 8;
    if (bytes.byteLength < offset + 4) return;
    const sessionLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); offset += 4 + sessionLength;
    if (bytes.byteLength < offset + 4) return;
    const audioLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); offset += 4;
    const audio = bytes.slice(offset, offset + audioLength);
    if (audio.byteLength) this.push(audio);
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.waiting.push(resolve); this.rejecting.push(reject); });
  }

  private fail(message: string) {
    this.failure = new Error(`Volcengine TTS: ${message}`);
    this.done = true;
    this.waiting.length = 0;
    for (const reject of this.rejecting.splice(0)) reject(this.failure);
    this.socket.close();
  }

  private push(chunk: Uint8Array) {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else this.queue.push(chunk);
  }

  private finishQueue() {
    this.done = true;
    this.rejecting.length = 0;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }
}

/** Error frames carry a 4-byte code, a 4-byte size and a JSON or text body. */
function errorFrameMessage(bytes: Uint8Array): string {
  const body = new TextDecoder().decode(bytes.slice(8)).replace(/[^\x20-\x7e\u00a0-\uffff]/g, "").trim();
  try {
    const parsed = JSON.parse(body.slice(body.indexOf("{"))) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch { /* Fall through to the raw text. */ }
  return body.slice(0, 200) || "request rejected";
}

function volcengineFrame(messageType: number, flags: number, serialization: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame[0] = 0x11;
  frame[1] = (messageType << 4) | flags;
  frame[2] = serialization << 4;
  new DataView(frame.buffer).setUint32(4, payload.byteLength);
  frame.set(payload, 8);
  return frame;
}
