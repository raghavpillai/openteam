import type { OpusCodec } from "./voice-media";

export class VoiceEncoder {
  constructor(private readonly codec: OpusCodec) {}
  encode(pcm: Int16Array) { return this.codec.encode(pcm); }
  close() { return this.codec.close(); }
}
