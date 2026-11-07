import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  decodeVoiceFrame,
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
  VOICE_FRAME_MS,
  VOICE_MAX_FRAME_BYTES,
  type VoiceControlMessage,
} from "@openteam/contracts";
import { VoiceMediaQueue } from "./voice-media";

export interface VoiceConnectionData {
  sessionId: string;
  connection: VoiceSessionConnection;
}

export interface VoiceSessionConnectionOptions {
  sessionId: string;
  onHello: (echoCancellation: boolean) => Promise<void>;
  onControl: (message: VoiceControlMessage) => Promise<void>;
  onInputFrame: (bytes: Uint8Array) => Promise<void>;
  onClose: () => Promise<void>;
}

export class VoiceSessionConnection {
  private socket: ServerWebSocket<VoiceConnectionData> | null = null;
  private serverSequence = 0;
  private lastClientSequence = -1;
  private closed = false;
  private readonly outputWaiters = new Set<() => void>();
  readonly media = new VoiceMediaQueue();

  constructor(private readonly options: VoiceSessionConnectionOptions) {}

  attach(socket: ServerWebSocket<VoiceConnectionData>) { this.socket = socket; }

  send(message: Record<string, unknown>) {
    if (this.closed || !this.socket) return;
    const payload = JSON.stringify({ ...message, version: 1, sessionId: this.options.sessionId, sequence: this.serverSequence++ });
    if (payload.length > 64 * 1024) { this.close(1009, "Voice control message is too large"); return; }
    if (this.socket.send(payload) === 0) this.close(1013, "Voice client is too slow");
  }

  sendAudio(frame: Uint8Array) {
    if (this.closed || !this.socket) return;
    if (frame.byteLength > VOICE_MAX_FRAME_BYTES || this.socket.send(frame) === 0) this.close(1013, "Voice client is too slow");
  }

  async queueAudio(packet: Uint8Array, timestampMs: number) {
    while (!this.closed && this.media.bufferedMs + 20 > 2_000) {
      await new Promise<void>(resolve => this.outputWaiters.add(resolve));
    }
    if (this.closed) return;
    this.media.push(packet, timestampMs);
    for (const frame of this.media.takeSendable(this.media.playbackPositionMs)) this.sendAudio(frame);
  }

  acknowledgePlayback(generation: number, sequence: number) {
    this.media.acknowledge(generation, sequence);
    this.wakeOutputWaiters();
    for (const frame of this.media.takeSendable(this.media.playbackPositionMs)) this.sendAudio(frame);
  }

  stopOutputGeneration() {
    const generation = this.media.stopGeneration();
    this.wakeOutputWaiters();
    return generation;
  }

  private wakeOutputWaiters() {
    for (const resolve of this.outputWaiters) resolve();
    this.outputWaiters.clear();
  }

  async message(message: string | Uint8Array) {
    if (this.closed) return;
    if (typeof message !== "string") {
      await this.options.onInputFrame(message);
      return;
    }
    let parsed: VoiceControlMessage;
    try { parsed = JSON.parse(message) as VoiceControlMessage; } catch { this.close(1003, "Invalid voice control message"); return; }
    if (!parsed || parsed.version !== 1 || parsed.sessionId !== this.options.sessionId || !Number.isSafeInteger(parsed.sequence) || parsed.sequence <= this.lastClientSequence) {
      this.close(1008, "Invalid voice control sequence"); return;
    }
    this.lastClientSequence = parsed.sequence;
    if (parsed.type === "hello") await this.options.onHello(parsed.echoCancellation !== false);
    else await this.options.onControl(parsed);
  }

  async close(code = 1000, reason = "Voice session closed") {
    if (this.closed) return;
    this.closed = true;
    this.wakeOutputWaiters();
    this.socket?.close(code, reason);
    this.socket = null;
    await this.options.onClose();
  }

  static handler(): WebSocketHandler<VoiceConnectionData> {
    return {
      maxPayloadLength: VOICE_MAX_FRAME_BYTES,
      backpressureLimit: 2 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      sendPings: true,
      open: socket => socket.data.connection.attach(socket),
      message: (socket, message) => void socket.data.connection.message(message as string | Uint8Array).catch(error => {
        socket.data.connection.send({
          type: "error",
          code: "voice_stream_failed",
          message: error instanceof Error ? error.message : "Voice input processing failed",
          retryable: true,
        });
        void socket.data.connection.close(1011, "Voice session failed");
      }),
      close: socket => void socket.data.connection.close(),
    };
  }
}

export const voiceAudioConfig = (sampleRate: number) => ({ codec: "opus" as const, sampleRate, channels: 1 as const, frameMs: VOICE_FRAME_MS as 20, maxFrameBytes: VOICE_MAX_FRAME_BYTES });
export const voiceInputConfig = () => voiceAudioConfig(VOICE_INPUT_SAMPLE_RATE);
export const voiceOutputConfig = () => voiceAudioConfig(VOICE_OUTPUT_SAMPLE_RATE);

