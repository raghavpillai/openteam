import { ApiError } from "@openteam/contracts";
import {
  MAX_VOICE_NOTE_BYTES,
  type TranscriptionCheck,
  type TranscriptionResult,
} from "@openteam/contracts/transcription";
import type { TranscriptionStore } from "./store";

const AUDIO_FORMATS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

async function boundedBytes(
  response: Request | Response,
  limit: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const invalidResponse = () =>
    new ApiError(
      502,
      "invalid_transcription_response",
      "The transcription provider returned an invalid response."
    );
  const tooLarge = () =>
    response instanceof Request
      ? new ApiError(413, "audio_too_large", "Voice notes must be 25 MB or smaller.")
      : invalidResponse();
  if (Number(response.headers.get("content-length")) > limit) throw tooLarge();
  if (!response.body)
    throw response instanceof Request
      ? new ApiError(400, "empty_audio", "No recording was received.")
      : invalidResponse();
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const providerFailure = (status: number) =>
  new ApiError(
    status === 429 ? 429 : 502,
    "transcription_provider_error",
    status === 401 || status === 403
      ? "The transcription provider rejected the API key. Check Server settings."
      : status === 404
        ? "The transcription endpoint or model was not found. Check the base URL and model in Server settings."
        : status === 429
          ? "The transcription provider is busy or its quota has been reached. Try again later."
          : status === 400 || status === 415 || status === 422
            ? "The transcription provider rejected this recording or model. Check its supported audio formats and Server settings."
            : `The transcription provider failed (HTTP ${status}). Try again later.`
  );

export class TranscriptionService {
  private active = 0;
  constructor(
    readonly store: TranscriptionStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async check(): Promise<TranscriptionCheck> {
    const status = await this.store.status();
    if (status === "missing")
      return {
        level: "warn",
        status: "missing",
        detail:
          "Not configured; voice notes are disabled. Set up Transcription in Server settings.",
      };
    if (status === "invalid")
      return {
        level: "fail",
        status: "invalid",
        detail:
          "Saved transcription settings or credentials are invalid. Save them again in Server settings.",
      };
    try {
      const settings = await this.store.credentials();
      const response = await this.fetchImpl(`${settings.baseUrl}/models`, {
        headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel();
        return {
          level: "warn",
          status: "unverified",
          detail:
            "Server is reachable but does not support model discovery. Transcription and model availability are not yet verified; try a voice note.",
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerFailure(response.status);
      }
      const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1024 * 1024)));
      if (
        !Array.isArray(body.data) ||
        !body.data.every(
          (m: unknown) =>
            m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string"
        )
      ) {
        return {
          level: "fail",
          status: "invalid",
          detail:
            "The base URL did not return an OpenAI-compatible model list. Check its API path (usually /v1).",
        };
      }
      if (!body.data.some((m: { id: string }) => m.id === settings.model))
        return {
          level: "warn",
          status: "unverified",
          detail: `Server is reachable; ${settings.model} is not listed. Some servers load models on demand. Try a voice note to verify it.`,
        };
      return {
        level: "pass",
        status: "ready",
        detail: `${settings.model} is listed and reachable from the OpenTeam server. No audio was sent.`,
      };
    } catch (error) {
      return {
        level: "fail",
        status: "unavailable",
        detail:
          error instanceof ApiError
            ? error.message
            : "The transcription provider could not be reached or returned an invalid response. Check the base URL, network, and service.",
      };
    }
  }

  async transcribe(request: Request): Promise<TranscriptionResult> {
    const settings = await this.store.credentials();
    if (this.active >= 2)
      throw new ApiError(
        429,
        "transcription_busy",
        "Two voice notes are already processing. Try again shortly."
      );
    const mimeType = (request.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const extension = AUDIO_FORMATS[mimeType];
    if (!extension)
      throw new ApiError(
        415,
        "unsupported_audio",
        "Use a WAV, WebM, M4A, MP3, MP4, OGG, or FLAC recording."
      );
    this.active++;
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
      const bytes = await boundedBytes(request, MAX_VOICE_NOTE_BYTES, signal);
      if (bytes.length < 44)
        throw new ApiError(
          400,
          "empty_audio",
          "The recording is empty or too short. Try speaking for longer."
        );
      request.signal.throwIfAborted();
      const body = new FormData();
      body.append(
        "file",
        new Blob([bytes as BlobPart], { type: mimeType }),
        `voice-note.${extension}`
      );
      body.append("model", settings.model);
      body.append("response_format", "json");
      if (settings.language) body.append("language", settings.language);
      const response = await this.fetchImpl(`${settings.baseUrl}/audio/transcriptions`, {
        method: "POST",
        body,
        headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw providerFailure(response.status);
      }
      const result = JSON.parse(
        new TextDecoder().decode(await boundedBytes(response, 1024 * 1024, signal))
      );
      if (typeof result?.text !== "string" || result.text.length > 100_000)
        throw new ApiError(
          502,
          "invalid_transcription_response",
          "The transcription provider returned an invalid transcript."
        );
      const text = result.text.trim();
      if (!text)
        throw new ApiError(422, "no_speech", "No speech was detected. Try recording again.");
      request.signal.throwIfAborted();
      return { text };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (request.signal.aborted)
        throw new ApiError(499, "transcription_cancelled", "Voice note cancelled.");
      if (error instanceof Error && error.name === "TimeoutError")
        throw new ApiError(
          504,
          "transcription_timeout",
          "Transcription took too long. Try a shorter recording or check the provider."
        );
      throw new ApiError(
        502,
        "transcription_unavailable",
        "Transcription failed. Check the provider connection in Server settings and try again."
      );
    } finally {
      this.active--;
    }
  }
}
