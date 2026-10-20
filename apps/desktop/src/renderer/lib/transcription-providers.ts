import type { TranscriptionSettings } from "@openteam/contracts/transcription";

/** Hosted services fill in their own address and default model. */
export const HOSTED_TRANSCRIPTION_ENDPOINTS: Partial<
  Record<TranscriptionSettings["provider"], string>
> = {
  openai: "https://api.openai.com/v1",
  deepgram: "https://api.deepgram.com/v1",
};
export const HOSTED_TRANSCRIPTION_MODELS: Partial<
  Record<TranscriptionSettings["provider"], string>
> = {
  openai: "gpt-transcribe",
  deepgram: "nova-3",
};
