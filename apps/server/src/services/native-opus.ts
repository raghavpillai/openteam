import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import type { OpusCodec } from "./voice-media";

const OPUS_APPLICATION_VOIP = 2048;
const candidates = () => [
  process.env.OPENTEAM_OPUS_LIBRARY,
  process.platform === "darwin" ? "libopus.dylib" : "libopus.so.0",
  process.platform === "darwin" ? "/opt/homebrew/lib/libopus.dylib" : "/usr/lib/libopus.so.0",
].filter((value): value is string => Boolean(value));

type OpusSymbols = {
  opus_encoder_create: (sampleRate: number, channels: number, application: number, error: Pointer) => Pointer;
  opus_encoder_destroy: (encoder: Pointer) => void;
  opus_encode: (encoder: Pointer, pcm: Pointer, frameSize: number, packet: Pointer, maxPacketBytes: number) => number;
  opus_decoder_create: (sampleRate: number, channels: number, error: Pointer) => Pointer;
  opus_decoder_destroy: (decoder: Pointer) => void;
  opus_decode: (decoder: Pointer, packet: Pointer, packetBytes: number, pcm: Pointer, frameSize: number, decodeFec: number) => number;
};

const loadSymbols = () => {
  for (const path of candidates()) {
    try {
      return dlopen(path, {
        opus_encoder_create: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
        opus_encoder_destroy: { args: [FFIType.ptr], returns: FFIType.void },
        opus_encode: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        opus_decoder_create: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
        opus_decoder_destroy: { args: [FFIType.ptr], returns: FFIType.void },
        opus_decode: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      }).symbols as unknown as OpusSymbols;
    } catch { /* Try the next platform/library location. */ }
  }
  throw new Error("libopus is not installed; set OPENTEAM_OPUS_LIBRARY to a compatible library");
};

export class NativeOpusCodec implements OpusCodec {
  private readonly symbols: OpusSymbols;
  private readonly encoder: Pointer;
  private readonly decoder: Pointer;
  private closed = false;

  constructor(private readonly sampleRate: 48_000 | 24_000 = 48_000) {
    this.symbols = loadSymbols();
    const encoderError = new Int32Array(1);
    const decoderError = new Int32Array(1);
    this.encoder = this.symbols.opus_encoder_create(sampleRate, 1, OPUS_APPLICATION_VOIP, ptr(encoderError));
    this.decoder = this.symbols.opus_decoder_create(sampleRate, 1, ptr(decoderError));
    if (!this.encoder || !this.decoder || encoderError[0] !== 0 || decoderError[0] !== 0) throw new Error("libopus could not create a codec");
  }

  async decode(packet: Uint8Array): Promise<Int16Array> {
    if (this.closed) throw new Error("Opus codec is closed");
    const pcm = new Int16Array(this.sampleRate === 48_000 ? 960 : 480);
    const decoded = this.symbols.opus_decode(this.decoder, ptr(packet), packet.byteLength, ptr(pcm), pcm.length, 0);
    if (decoded < 0) throw new Error("libopus decode failed");
    return decoded === pcm.length ? pcm : pcm.slice(0, decoded);
  }

  async encode(pcm: Int16Array): Promise<Uint8Array> {
    if (this.closed) throw new Error("Opus codec is closed");
    const packet = new Uint8Array(1500);
    const encoded = this.symbols.opus_encode(this.encoder, ptr(pcm), pcm.length, ptr(packet), packet.byteLength);
    if (encoded <= 0) throw new Error("libopus encode failed");
    return packet.slice(0, encoded);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.symbols.opus_encoder_destroy(this.encoder);
    this.symbols.opus_decoder_destroy(this.decoder);
  }
}
