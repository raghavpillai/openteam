/** Voice notes are uploaded after recording; these settings are independent of chat inference. */
export interface TranscriptionSettings {
  enabled: boolean;
  provider: "openai" | "openai-compatible";
  baseUrl: string;
  model: string;
  language: string;
}

export interface TranscriptionSettingsInput extends TranscriptionSettings {
  /** Omit to keep the saved key; null explicitly removes it. Never returned to clients. */
  apiKey?: string | null;
}

export interface TranscriptionSettingsView extends TranscriptionSettings {
  hasApiKey: boolean;
  configured: boolean;
}

export interface TranscriptionCheck {
  level: "pass" | "warn" | "fail";
  status: "missing" | "ready" | "unverified" | "unavailable" | "invalid";
  detail: string;
}

export interface TranscriptionResult {
  text: string;
}

export const MAX_VOICE_NOTE_MS = 300_000;
export const MAX_VOICE_NOTE_BYTES = 25 * 1024 * 1024;
export const MIN_VOICE_NOTE_MS = 500;

export const defaultTranscriptionSettings = (): TranscriptionSettings => ({
  enabled: false,
  provider: "openai-compatible",
  baseUrl: "",
  model: "",
  language: "",
});
