import { Application, createDecoder, createEncoder, Signal, type OpusDecoderHandle, type OpusEncoderHandle } from "libopus-wasm";
import { openMicrophone } from "./microphone";
import { decodeVoiceFrame, encodeVoiceFrame, VOICE_FRAME_MS, VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from "@openteam/contracts/voice";

const CAPTURE_WORKLET_URL = new URL("../worklets/live-voice-capture.ts", import.meta.url);

export interface LiveVoiceAudioEvents {
  onFrame?: (frame: Uint8Array) => void;
  onPlaybackAck?: (generation: number, sequence: number) => void;
  onPlaybackStopped?: () => void;
}

/**
 * Owns the renderer microphone and speaker graph for a realtime voice session.
 * The codec produces and consumes raw 20 ms Opus packets; WebSocket framing is
 * kept in LiveVoiceTransport.
 */
export class LiveVoiceAudio {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | ScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private output: GainNode | null = null;
  private encoder: OpusEncoderHandle | null = null;
  private decoder: OpusDecoderHandle | null = null;
  private captureSamples: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private inputSequence = 0;
  private playbackCursor = 0;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private microphoneMuted = false;
  private speakerMuted = false;
  private closed = false;

  constructor(private readonly events: LiveVoiceAudioEvents = {}) {}

  static supportsNativeOpus(): boolean {
    return typeof AudioEncoder === "function" && typeof AudioDecoder === "function";
  }

  async start(): Promise<{ echoCancellation: boolean; sampleRate: number }> {
    if (this.context) return { echoCancellation: true, sampleRate: this.context.sampleRate };
    this.closed = false;
    const opened = await openMicrophone();
    this.stream = opened.stream;
    try {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: VOICE_INPUT_SAMPLE_RATE });
      this.context = context;
      this.output = context.createGain();
      this.output.gain.value = 1;
      this.output.connect(context.destination);
      this.captureSink = context.createGain();
      this.captureSink.gain.value = 0;
      this.captureSink.connect(context.destination);
      this.source = context.createMediaStreamSource(this.stream);
      this.encoder = await createEncoder({
        sampleRate: VOICE_INPUT_SAMPLE_RATE,
        channels: 1,
        frameSize: 960,
        application: Application.Voip,
        bitrate: 24_000,
        complexity: 5,
        signal: Signal.Voice,
      });
      this.decoder = await createDecoder({ sampleRate: VOICE_OUTPUT_SAMPLE_RATE, channels: 1, maxFrameSize: 480 });
      await context.resume();
      if (audioWorkletFor(context) && typeof AudioWorkletNode === "function") {
        await this.startWorklet(context);
      } else {
        this.startScriptProcessor(context);
      }
      const echoCancellation = this.stream.getAudioTracks().every(track => track.getSettings().echoCancellation !== false);
      return { echoCancellation, sampleRate: context.sampleRate };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  setMicrophoneMuted(muted: boolean): void {
    this.microphoneMuted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    if (this.output) this.output.gain.value = muted ? 0 : 1;
  }

  handleOutputFrame(bytes: Uint8Array): void {
    if (this.closed || !this.context || !this.decoder || !this.output) return;
    const frame = decodeVoiceFrame(bytes, "output");
    const pcm = this.decoder.decode(frame.payload, { frameSize: 480 });
    const samples = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index]! / 32768;
    const audio = this.context;
    const buffer = audio.createBuffer(1, samples.length, VOICE_OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    const now = audio.currentTime;
    this.playbackCursor = Math.max(this.playbackCursor, now + 0.02);
    const startAt = this.playbackCursor;
    this.playbackCursor += (samples.length / VOICE_OUTPUT_SAMPLE_RATE);
    this.playbackSources.add(source);
    source.onended = () => {
      this.playbackSources.delete(source);
      this.events.onPlaybackAck?.(frame.generation, frame.sequence);
    };
    source.start(startAt);
  }

  stopPlayback(): void {
    const now = this.context?.currentTime ?? 0;
    for (const source of this.playbackSources) {
      try { source.stop(now); } catch { /* The source may already have ended. */ }
    }
    this.playbackSources.clear();
    this.playbackCursor = now;
    this.events.onPlaybackStopped?.();
  }

  async close(): Promise<void> {
    if (this.closed && !this.context && !this.stream) return;
    this.closed = true;
    this.stopPlayback();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.captureSink?.disconnect();
    this.output?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.encoder?.free();
    this.decoder?.free();
    await this.context?.close().catch(() => undefined);
    this.processor = null;
    this.source = null;
    this.captureSink = null;
    this.output = null;
    this.stream = null;
    this.context = null;
    this.encoder = null;
    this.decoder = null;
    this.captureSamples = new Float32Array(0);
    this.inputSequence = 0;
  }

  private async startWorklet(context: AudioContext): Promise<void> {
    const source = this.source;
    const sink = this.captureSink;
    const audioWorklet = audioWorkletFor(context);
    if (!source || !sink || !audioWorklet) throw new Error("Voice capture graph is unavailable");
    await audioWorklet.addModule(CAPTURE_WORKLET_URL);
    const node = new AudioWorkletNode(context, "openteam-voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => this.pushSamples(event.data, context.sampleRate);
    source.connect(node);
    node.connect(sink);
    this.processor = node;
  }

  private startScriptProcessor(context: AudioContext): void {
    const source = this.source;
    const sink = this.captureSink;
    if (!source || !sink) throw new Error("Voice capture graph is unavailable");
    const processor = context.createScriptProcessor(960, 1, 1);
    processor.onaudioprocess = event => this.pushSamples(event.inputBuffer.getChannelData(0), context.sampleRate);
    source.connect(processor);
    processor.connect(sink);
    this.processor = processor;
  }

  private pushSamples(samples: Float32Array<ArrayBufferLike>, inputRate: number): void {
    if (this.closed || !this.encoder) return;
    const normalized = inputRate === VOICE_INPUT_SAMPLE_RATE ? samples : resample(samples, inputRate, VOICE_INPUT_SAMPLE_RATE);
    this.captureSamples = appendSamples(this.captureSamples, this.microphoneMuted ? new Float32Array(normalized.length) : normalized);
    while (this.captureSamples.length >= 960) {
      const frameSamples = this.captureSamples.slice(0, 960);
      this.captureSamples = this.captureSamples.slice(960);
      const packet = this.encoder.encodeFloat(frameSamples);
      this.events.onFrame?.(encodeVoiceFrame({
        kind: "input",
        version: 1,
        generation: 0,
        sequence: this.inputSequence++,
        timestampMs: Math.round(performance.now()),
        payload: packet,
      }));
    }
  }
}

function appendSamples(left: Float32Array<ArrayBufferLike>, right: Float32Array<ArrayBufferLike>): Float32Array<ArrayBufferLike> {
  const result = new Float32Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function resample(samples: Float32Array<ArrayBufferLike>, inputRate: number, outputRate: number): Float32Array<ArrayBufferLike> {
  if (samples.length === 0 || inputRate === outputRate) return samples;
  const length = Math.max(1, Math.round(samples.length * outputRate / inputRate));
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * inputRate / outputRate;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    result[index] = samples[left]! * (1 - fraction) + samples[right]! * fraction;
  }
  return result;
}

function audioWorkletFor(context: AudioContext): AudioWorklet | undefined {
  return (context as AudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
}
