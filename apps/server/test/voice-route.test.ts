import { describe, expect, test } from "bun:test";
import { isVoiceStreamPath, voiceRoutes } from "../src/routes/voice";
import type { RouteContext } from "../src/routes/context";

const view = {
  enabled: false,
  defaultProvider: "volcengine" as const,
  providers: {
    volcengine: { configured: false, stt: false, tts: false, baseUrl: "https://openspeech.bytedance.com" },
    deepgram: { configured: false, stt: false, tts: false, baseUrl: "https://api.deepgram.com" },
  },
  sttModel: "nova-3",
  ttsModel: "aura-2-thalia-en",
  voice: "alloy",
  language: "en-US",
};

const context = (request: Request) => ({
  app: {
    voice: {
      settings: {
        view: async () => view,
        save: async () => view,
      },
    },
  },
  request,
  url: new URL(request.url),
  path: "/api/server-settings/voice",
  authMode: "disabled" as const,
  authenticatedSessionId: null,
} as unknown as RouteContext);

describe("realtime voice settings route", () => {
  test("recognizes the ticket-authenticated stream route before session auth", () => {
    expect(isVoiceStreamPath("GET", "/api/voice/sessions/session-id/stream")).toBe(true);
    expect(isVoiceStreamPath("POST", "/api/voice/sessions/session-id/stream")).toBe(false);
    expect(isVoiceStreamPath("GET", "/api/voice/sessions/session-id")).toBe(false);
  });

  test("awaits the settings view before serializing GET responses", async () => {
    const response = await voiceRoutes(context(new Request("http://localhost/api/server-settings/voice")));
    expect(response).toBeInstanceOf(Response);
    expect(await response?.json()).toMatchObject({ providers: { volcengine: { baseUrl: "https://openspeech.bytedance.com" } } });
  });

  test("awaits the settings save before serializing PUT responses", async () => {
    const response = await voiceRoutes(
      context(
        new Request("http://localhost/api/server-settings/voice", {
          method: "PUT",
          body: JSON.stringify({
            enabled: false,
            defaultProvider: "volcengine",
            volcengineBaseUrl: "https://openspeech.bytedance.com",
            volcengineSttUrl: "",
            volcengineTtsUrl: "",
            volcengineSttResourceId: "volc.seedasr.sauc.duration",
            volcengineTtsResourceId: "seed-tts-2.0",
            deepgramBaseUrl: "https://api.deepgram.com",
            sttModel: "nova-3",
            ttsModel: "aura-2-thalia-en",
            voice: "alloy",
            language: "en-US",
          }),
        }),
      ),
    );
    expect(response).toBeInstanceOf(Response);
    expect(await response?.json()).toMatchObject({ providers: { volcengine: { configured: false } } });
  });
});
