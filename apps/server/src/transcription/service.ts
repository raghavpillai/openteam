import { isTranscriptionModel } from "@openteam/contracts/model-kind";
import { ApiError } from "@openteam/contracts";
import {
  MAX_VOICE_NOTE_BYTES,
  type TranscriptionCheck,
  type TranscriptionResult,
  type TranscriptionSettings,
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

type ProviderCredentials = Pick<TranscriptionSettings, "provider"> & { apiKey: string | null };
const providerHeaders = ({ provider, apiKey }: ProviderCredentials): HeadersInit =>
  apiKey ? { authorization: `${provider === "deepgram" ? "Token" : "Bearer"} ${apiKey}` } : {};

/** Deepgram's catalog separates batch-capable speech models from TTS and streaming-only models. */
function providerModels(
  body: unknown,
  provider: TranscriptionSettings["provider"]
): Record<string, unknown>[] {
  const catalog = body as { stt?: unknown; data?: unknown } | null;
  const models = provider === "deepgram" ? catalog?.stt : catalog?.data;
  if (!Array.isArray(models)) throw new Error("Invalid catalog");
  return models
    .map((model: unknown) => {
      if (!model || typeof model !== "object") throw new Error("Invalid catalog");
      const value = model as Record<string, unknown>;
      const id = provider === "deepgram" ? (value.canonical_name ?? value.name) : value.id;
      if (typeof id !== "string" || !id || id.length > 256 || /[\p{Cc}\p{Cf}]/u.test(id))
        throw new Error("Invalid catalog");
      return provider === "deepgram" ? { ...value, id, task: "transcription" } : value;
    })
    .filter((model) => provider !== "deepgram" || model.batch === true);
}

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

  async models(input: unknown): Promise<{ models: string[] }> {
    const settings = await this.store.discoveryCredentials(input);
    try {
      const response = await this.fetchImpl(`${settings.baseUrl}/models`, {
        headers: providerHeaders(settings),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 || response.status === 405)
          throw new ApiError(
            422,
            "model_discovery_unavailable",
            "This provider does not offer model discovery. Enter its transcription model ID manually."
          );
        throw providerFailure(response.status);
      }
      const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1024 * 1024)));
      const models = providerModels(body, settings.provider);
      return {
        models: [
          ...new Set<string>(
            models
              .filter((m: Record<string, unknown>) =>
                isTranscriptionModel(m, settings.baseUrl !== "https://api.openai.com/v1")
              )
              .map((m) => m.id as string)
          ),
        ].sort(),
      };
    } catch (error) {
      if (error instanceof ApiError && error.code !== "invalid_transcription_response") throw error;
      throw new ApiError(
        502,
        "model_discovery_failed",
        "Could not load transcription models. Check the base URL, credentials and connection, or enter a model ID manually."
      );
    }
  }

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
        headers: providerHeaders(settings),
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
      let models: Record<string, unknown>[];
      try {
        models = providerModels(body, settings.provider);
      } catch {
        return {
          level: "fail",
          status: "invalid",
          detail:
            settings.provider === "deepgram"
              ? "Deepgram did not return a valid speech-to-text model list. Try again later."
              : "The base URL did not return an OpenAI-compatible model list. Check its API path (usually /v1).",
        };
      }
      if (
        !models.some(
          (m) =>
            m.id === settings.model ||
            (settings.provider === "deepgram" &&
              (m.name === settings.model || m.uuid === settings.model))
        )
      )
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
      let url = `${settings.baseUrl}/audio/transcriptions`;
      let body: BodyInit;
      const headers = new Headers(providerHeaders(settings));
      if (settings.provider === "deepgram") {
        const endpoint = new URL(`${settings.baseUrl}/listen`);
        endpoint.searchParams.set("model", settings.model);
        endpoint.searchParams.set("smart_format", "true");
        if (settings.language) endpoint.searchParams.set("language", settings.language);
        else endpoint.searchParams.set("detect_language", "true");
        url = endpoint.toString();
        body = new Blob([bytes as BlobPart], { type: mimeType });
        headers.set("content-type", mimeType);
      } else {
        const form = new FormData();
        form.append(
          "file",
          new Blob([bytes as BlobPart], { type: mimeType }),
          `voice-note.${extension}`
        );
        form.append("model", settings.model);
        const gptTranscribe =
          settings.provider === "openai" && /^gpt-transcribe(?:-|$)/.test(settings.model);
        // GPT Transcribe returns JSON by default and accepts plural language hints.
        if (!gptTranscribe) form.append("response_format", "json");
        if (settings.language)
          form.append(gptTranscribe ? "languages[]" : "language", settings.language);
        body = form;
      }
      const response = await this.fetchImpl(url, {
        method: "POST",
        body,
        headers,
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
      const transcript =
        settings.provider === "deepgram"
          ? result?.results?.channels?.[0]?.alternatives?.[0]?.transcript
          : result?.text;
      if (typeof transcript !== "string" || transcript.length > 100_000)
        throw new ApiError(
          502,
          "invalid_transcription_response",
          "The transcription provider returned an invalid transcript."
        );
      const text = transcript.trim();
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
