import { Schema } from "effect";

export const VOICE_PROTOCOL_VERSION = 1 as const;
export const VOICE_PROTOCOL = "openteam-voice.v1" as const;
export const VOICE_FRAME_HEADER_BYTES = 18 as const;
export const VOICE_MAX_FRAME_BYTES = 1500 as const;
export const VOICE_MAX_OPUS_PACKET_BYTES = 1275 as const;
export const VOICE_INPUT_SAMPLE_RATE = 48_000 as const;
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000 as const;
export const VOICE_FRAME_MS = 20 as const;
export const VOICE_MAX_SESSION_MS = 30 * 60_000;
export const VOICE_MAX_TURN_MS = 60_000;
export const VOICE_PLAYBACK_LEAD_MS = 1_000;
export const VOICE_PLAYBACK_ACK_TIMEOUT_MS = 5_000;

export const VoiceClientPlatform = Schema.Literal("macos", "ios", "android");
export type VoiceClientPlatform = typeof VoiceClientPlatform.Type;
export const VoiceProviderId = Schema.Literal("volcengine", "deepgram");
export type VoiceProviderId = typeof VoiceProviderId.Type;
export const VoiceSessionStatus = Schema.Literal("created", "active", "closing", "ended", "failed");
export type VoiceSessionStatus = typeof VoiceSessionStatus.Type;
export const VoiceTurnStatus = Schema.Literal("listening", "processing", "speaking", "output_paused", "completed", "superseded", "interrupted", "cancelled", "failed");
export type VoiceTurnStatus = typeof VoiceTurnStatus.Type;

export const VoiceSessionCreateInput = Schema.Struct({
  botId: Schema.String,
  channelId: Schema.String,
  clientPlatform: VoiceClientPlatform,
  clientInstanceId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200)),
  timeZone: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))),
  provider: Schema.optional(VoiceProviderId),
});
export type VoiceSessionCreateInput = typeof VoiceSessionCreateInput.Type;

export const VoiceSettingsInput = Schema.Struct({
  enabled: Schema.Boolean,
  defaultProvider: VoiceProviderId,
  volcengineApiKey: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(20_000)))),
  volcengineBaseUrl: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  volcengineSttUrl: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  volcengineTtsUrl: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  volcengineSttResourceId: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  volcengineTtsResourceId: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  deepgramApiKey: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(20_000)))),
  deepgramBaseUrl: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  sttModel: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  ttsModel: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  voice: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  language: Schema.optional(Schema.String.pipe(Schema.maxLength(40))),
  /** `provider/model` used for spoken progress narration; blank reuses the bot's own model. Omitted keeps the saved value. */
  narrationModel: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
});
export type VoiceSettingsInput = typeof VoiceSettingsInput.Type;

export interface VoiceAudioConfig { codec: "opus"; sampleRate: number; channels: 1; frameMs: 20; maxFrameBytes: number }
export interface VoiceSessionView { id: string; botId: string; conversationId: string; channelId: string; clientPlatform: VoiceClientPlatform; provider: VoiceProviderId; status: VoiceSessionStatus; expiresAt: string; createdAt: string; input: VoiceAudioConfig; output: VoiceAudioConfig; limits: { maxSessionMs: number; maxTurnMs: number } }
export interface VoiceSessionTicketView extends VoiceSessionView { path: string; protocols: [typeof VOICE_PROTOCOL, string] }
export interface VoiceTurnView { id: string; sessionId: string; status: VoiceTurnStatus; transcript: string | null; userMessageId: string | null; runId: string | null; assistantMessageIds: string[]; generation: number; createdAt: string; completedAt: string | null }
export interface VoiceProviderSettingsView {
  configured: boolean;
  stt: boolean;
  tts: boolean;
  baseUrl: string | null;
  sttUrl?: string | null;
  ttsUrl?: string | null;
  sttResourceId?: string | null;
  ttsResourceId?: string | null;
  apiKeySuffix?: string | null;
}
export interface VoiceSettingsView {
  enabled: boolean;
  defaultProvider: VoiceProviderId;
  providers: Record<VoiceProviderId, VoiceProviderSettingsView>;
  sttModel: string;
  ttsModel: string;
  voice: string;
  language: string;
  narrationModel: string;
}

export type VoiceControlMessage =
  | { type: "hello"; version: 1; sessionId: string; sequence: number; echoCancellation: boolean }
  | { type: "client_ready"; version: 1; sessionId: string; sequence: number }
  | { type: "stop"; version: 1; sessionId: string; sequence: number }
  | { type: "cancel_turn"; version: 1; sessionId: string; sequence: number; turnId?: string }
  | { type: "playback.ack"; version: 1; sessionId: string; sequence: number; generation: number; frameSequence: number }
  | { type: "ping"; version: 1; sessionId: string; sequence: number };
export type VoiceServerMessage =
  | { type: "ready"; version: 1; sessionId: string; sequence: number; input: VoiceAudioConfig; output: VoiceAudioConfig; echoCancellation: boolean }
  | { type: "session.state"; version: 1; sessionId: string; sequence: number; state: VoiceSessionStatus }
  | { type: "turn.started"; version: 1; sessionId: string; sequence: number; turnId: string }
  | { type: "transcript.partial"; version: 1; sessionId: string; sequence: number; turnId: string; text: string; isFinal: false }
  | { type: "transcript.final"; version: 1; sessionId: string; sequence: number; turnId: string; text: string; isFinal: true }
  | { type: "reply.message"; version: 1; sessionId: string; sequence: number; turnId: string; messageId: string; text: string; generation: number }
  | { type: "audio.started"; version: 1; sessionId: string; sequence: number; turnId: string; generation: number }
  | { type: "audio.stopped"; version: 1; sessionId: string; sequence: number; generation: number; reason: "barge_in" | "stop" | "cancel" | "completed" }
  | { type: "barge_in"; version: 1; sessionId: string; sequence: number; turnId: string; generation: number }
  | { type: "turn.completed"; version: 1; sessionId: string; sequence: number; turnId: string; userMessageId: string; runId: string; assistantMessageIds: string[]; status: "completed" | "superseded" | "interrupted" }
  | { type: "error"; version: 1; sessionId: string; sequence: number; code: string; message: string; retryable: boolean }
  | { type: "ended"; version: 1; sessionId: string; sequence: number; reason: string }
  | { type: "pong"; version: 1; sessionId: string; sequence: number };

export interface VoiceFrame { kind: "input" | "output"; version: 1; generation: number; sequence: number; timestampMs: number; payload: Uint8Array }
export const encodeVoiceFrame = (frame: VoiceFrame): Uint8Array => {
  if (frame.payload.byteLength > VOICE_MAX_OPUS_PACKET_BYTES) throw new Error("Opus packet is too large");
  const result = new Uint8Array(VOICE_FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint16(0, 0x4f56); view.setUint8(2, frame.version); view.setUint8(3, frame.kind === "input" ? 1 : 2);
  view.setUint32(4, frame.generation >>> 0); view.setUint32(8, frame.sequence >>> 0); view.setUint32(12, frame.timestampMs >>> 0); view.setUint16(16, frame.payload.byteLength);
  result.set(frame.payload, VOICE_FRAME_HEADER_BYTES); return result;
};
export const decodeVoiceFrame = (bytes: Uint8Array, expectedKind?: VoiceFrame["kind"]): VoiceFrame => {
  if (bytes.byteLength < VOICE_FRAME_HEADER_BYTES || bytes.byteLength > VOICE_MAX_FRAME_BYTES) throw new Error("Voice frame length is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0x4f56 || view.getUint8(2) !== VOICE_PROTOCOL_VERSION) throw new Error("Voice frame header is invalid");
  const kindValue = view.getUint8(3); const kind = kindValue === 1 ? "input" : kindValue === 2 ? "output" : null;
  if (!kind || (expectedKind && kind !== expectedKind)) throw new Error("Voice frame direction is invalid");
  const payloadLength = view.getUint16(16);
  if (payloadLength > VOICE_MAX_OPUS_PACKET_BYTES || payloadLength + VOICE_FRAME_HEADER_BYTES !== bytes.byteLength) throw new Error("Voice frame payload length is invalid");
  return { kind, version: 1, generation: view.getUint32(4), sequence: view.getUint32(8), timestampMs: view.getUint32(12), payload: bytes.slice(VOICE_FRAME_HEADER_BYTES) };
};

export const voiceMessageMetadata = (input: { sessionId: string; turnId: string; durationMs: number; provider: VoiceProviderId; language?: string }) => ({
  sessionId: input.sessionId, turnId: input.turnId, durationMs: Math.max(0, Math.min(VOICE_MAX_TURN_MS, Math.round(input.durationMs))), provider: input.provider, ...(input.language ? { language: input.language } : {}),
});
