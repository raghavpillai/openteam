import { expect, test } from "bun:test";
import { uploadNativeVoiceNote } from "../src/native-transcription-upload";

test("native cancellation signals do not require the browser-only throwIfAborted method", async () => {
  // React Native's abort-controller polyfill exposes aborted and events only.
  const signal = { aborted: false } as AbortSignal;
  await expect(
    uploadNativeVoiceNote({
      serverUrl: "https://openteam.test",
      authToken: "session-token",
      signal,
      file: {
        createUploadTask: () => ({
          uploadAsync: async () => ({ status: 200, body: '{"text":"Native draft"}', headers: {} }),
        }),
      },
    })
  ).resolves.toEqual({ text: "Native draft" });
});

test("voice notes use authenticated ephemeral transcription uploads, not attachment storage", async () => {
  const abort = new AbortController();
  const result = await uploadNativeVoiceNote({
    serverUrl: "https://openteam.test",
    authToken: "session-token",
    signal: abort.signal,
    file: {
      createUploadTask(url, options) {
        expect(url).toBe("https://openteam.test/api/v0/transcriptions");
        expect(options?.headers?.authorization).toBe("Bearer session-token");
        expect(options?.mimeType).toBe("audio/wav");
        expect(options?.signal).toBe(abort.signal);
        return {
          uploadAsync: async () => ({ status: 200, body: '{"text":" Hello "}', headers: {} }),
        };
      },
    },
  });
  expect(result).toEqual({ text: "Hello" });
});

test("failed uploads invalidate expired auth and preserve actionable server errors", async () => {
  let invalidated = false;
  await expect(
    uploadNativeVoiceNote({
      serverUrl: "https://openteam.test",
      authToken: "expired",
      onUnauthorized: () => {
        invalidated = true;
      },
      file: {
        createUploadTask: () => ({
          uploadAsync: async () => ({
            status: 401,
            body: '{"error":{"message":"Sign in again"}}',
            headers: {},
          }),
        }),
      },
    })
  ).rejects.toThrow("Sign in again");
  expect(invalidated).toBe(true);
});

test("late results from cancelled uploads are discarded", async () => {
  const controller = new AbortController();
  await expect(
    uploadNativeVoiceNote({
      serverUrl: "https://openteam.test",
      authToken: null,
      signal: controller.signal,
      file: {
        createUploadTask: () => ({
          uploadAsync: async () => {
            controller.abort();
            return { status: 200, body: '{"text":"Do not insert"}', headers: {} };
          },
        }),
      },
    })
  ).rejects.toThrow();
});
