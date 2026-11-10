import type { VoiceProviderId } from "@openteam/contracts";

export interface SttResult { text: string; language?: string; providerMetadata?: Record<string, string | number | boolean> }
export interface SttEvent { text: string; isFinal: boolean; language?: string }
export interface StreamingStt {
  pushPcm(pcm: Int16Array): Promise<void>;
  finish(): Promise<SttResult | null>;
  cancel(): Promise<void>;
  onResult(listener: (event: SttEvent) => void): void;
}
export interface StreamingTts {
  writeText(text: string): Promise<void>;
  end(): Promise<void>;
  cancel(): Promise<void>;
  readonly audio: AsyncIterable<Uint8Array>;
}
export interface VoiceProvider {
  id: VoiceProviderId;
  stt(input: { language: string }): Promise<StreamingStt>;
  tts(input: { language: string; voice: string }): Promise<StreamingTts>;
}

export const redactProviderError = (error: unknown): Error => new Error(error instanceof Error ? `Voice provider request failed: ${error.name}` : "Voice provider request failed");
