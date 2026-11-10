import type { OpusCodec } from "./voice-media";

export class VoiceDecoder {
  constructor(private readonly codec: OpusCodec) {}
  decode(packet: Uint8Array) { return this.codec.decode(packet); }
  close() { return this.codec.close(); }
}
