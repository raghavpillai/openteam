import type { NativeUploadFile } from "./native-asset-upload";
import type { TranscriptionResult } from "@openteam/contracts/transcription";

const throwIfCancelled = (signal?: AbortSignal) => {
  // React Native's AbortSignal polyfill has no throwIfAborted() method.
  if (signal?.aborted)
    throw Object.assign(new Error("Voice note cancelled."), { name: "AbortError" });
};

export async function uploadNativeVoiceNote(input: {
  serverUrl: string;
  file: NativeUploadFile;
  authToken: string | null;
  signal?: AbortSignal;
  onUnauthorized?: () => void;
}): Promise<TranscriptionResult> {
  throwIfCancelled(input.signal);
  const task = input.file.createUploadTask(`${input.serverUrl}/api/v0/transcriptions`, {
    httpMethod: "POST",
    mimeType: "audio/wav",
    sessionType: "foreground",
    signal: input.signal,
    headers: {
      "content-type": "audio/wav",
      ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    },
  });
  const result = await task.uploadAsync();
  throwIfCancelled(input.signal);
  const body = (() => {
    try {
      return JSON.parse(result.body);
    } catch {
      return null;
    }
  })();
  if (result.status === 401) input.onUnauthorized?.();
  if (result.status < 200 || result.status >= 300)
    throw new Error(
      typeof body?.error?.message === "string"
        ? body.error.message
        : `Transcription failed (${result.status}).`
    );
  if (typeof body?.text !== "string" || !body.text.trim())
    throw new Error("No speech was detected. Try recording again.");
  return { text: body.text.trim() };
}
