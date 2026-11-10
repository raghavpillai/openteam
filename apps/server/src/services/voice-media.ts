import {
  decodeVoiceFrame,
  encodeVoiceFrame,
  VOICE_FRAME_MS,
  VOICE_MAX_OPUS_PACKET_BYTES,
  type VoiceFrame,
} from "@openteam/contracts";

export interface OpusCodec {
  decode(packet: Uint8Array): Promise<Int16Array>;
  encode(pcm: Int16Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The production codec is injected so platform/runtime selection never leaks into the protocol. */
export class UnavailableOpusCodec implements OpusCodec {
  async decode(_packet: Uint8Array): Promise<Int16Array> { throw new Error("Voice Opus decoder is not configured"); }
  async encode(_pcm: Int16Array): Promise<Uint8Array> { throw new Error("Voice Opus encoder is not configured"); }
  async close(): Promise<void> {}
}

export class VoiceMediaQueue {
  private readonly output: Array<VoiceFrame & { sent: boolean }> = [];
  private outputMs = 0;
  private generation = 0;
  private nextSequence = 0;
  private lastAckAt = Date.now();
  private playedThroughMs = 0;

  get currentGeneration() { return this.generation; }
  get bufferedMs() { return this.outputMs; }
  acknowledge(generation: number, sequence: number) {
    this.lastAckAt = Date.now();
    if (generation === this.generation) this.playedThroughMs = Math.max(this.playedThroughMs, (sequence + 1) * VOICE_FRAME_MS);
    while (this.output.length && (this.output[0]!.generation < generation || (this.output[0]!.generation === generation && this.output[0]!.sequence <= sequence))) {
      this.output.shift(); this.outputMs = Math.max(0, this.outputMs - VOICE_FRAME_MS);
    }
  }
  get playbackPositionMs() { return this.playedThroughMs; }
  playbackAckStalled(now = Date.now()) { return now - this.lastAckAt > 5_000 && this.outputMs >= 1_000; }
  stopGeneration() {
    this.generation = (this.generation + 1) >>> 0;
    this.nextSequence = 0;
    this.output.length = 0;
    this.outputMs = 0;
    this.playedThroughMs = 0;
    return this.generation;
  }
  push(packet: Uint8Array, timestampMs: number) {
    if (packet.byteLength > VOICE_MAX_OPUS_PACKET_BYTES) throw new Error("Opus packet is too large");
    if (this.outputMs + VOICE_FRAME_MS > 2_000) throw new Error("Voice output queue is full");
    const frame = encodeVoiceFrame({ kind: "output", version: 1, generation: this.generation, sequence: this.nextSequence++, timestampMs, payload: packet });
    this.output.push({ ...decodeVoiceFrame(frame, "output"), payload: packet, sent: false }); this.outputMs += VOICE_FRAME_MS;
    return frame;
  }
  takeSendable(playedThroughMs: number) {
    const allowed = Math.max(0, playedThroughMs + 1_000);
    const maxSequence = Math.floor(allowed / VOICE_FRAME_MS) - 1;
    return this.output.flatMap(frame => {
      if (frame.sent || frame.sequence > maxSequence) return [];
      frame.sent = true;
      return encodeVoiceFrame(frame);
    });
  }
}

export const pcm16Mono = (value: Int16Array): Int16Array => value;
