import { describe, expect, test } from "bun:test";
import { VoiceSettingsService } from "../src/services/voice-settings";

type Row = {
  id: string;
  enabled: boolean;
  provider: string;
  encryptedVolcengineApiKey: string | null;
  volcengineBaseUrl: string;
  volcengineSttUrl: string | null;
  volcengineTtsUrl: string | null;
  volcengineSttResourceId: string;
  volcengineTtsResourceId: string;
  encryptedDeepgramApiKey: string | null;
  deepgramBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  language: string;
};

const store = (initial: Row | null = null) => {
  let row: Row | null = initial;
  return {
    voiceSettings: {
      findUnique: async () => row,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        row = { ...create, ...update };
        return row;
      },
    },
  };
};

const input = {
  enabled: true,
  defaultProvider: "volcengine" as const,
  volcengineBaseUrl: "https://openspeech.bytedance.com",
  volcengineSttUrl: "",
  volcengineTtsUrl: "",
  volcengineSttResourceId: "volc.seedasr.sauc.duration",
  volcengineTtsResourceId: "seed-tts-2.0",
  deepgramBaseUrl: "https://api.deepgram.com",
  sttModel: "nova-3",
  ttsModel: "seed-tts-2.0",
  voice: "female",
  language: "en-US",
};

describe("persistent realtime voice settings", () => {
  test("encrypts provider keys and never returns the key value", async () => {
    const service = new VoiceSettingsService(store() as never, () => "x".repeat(32));
    const saved = await service.save({ ...input, volcengineApiKey: "volc-test-secret" });
    expect(saved.providers.volcengine.configured).toBe(true);
    expect(saved.providers.volcengine.apiKeySuffix).toBe("cret");
    expect(JSON.stringify(saved)).not.toContain("volc-test-secret");
    expect(service.runtime().volcengineApiKey).toBe("volc-test-secret");
  });

  test("preserves an omitted key and removes it only when explicitly cleared", async () => {
    const database = store();
    const service = new VoiceSettingsService(database as never, () => "y".repeat(32));
    await service.save({ ...input, volcengineApiKey: "volc-test-secret" });
    await service.save({ ...input, enabled: false });
    expect(service.runtime().volcengineApiKey).toBe("volc-test-secret");
    await service.save({ ...input, enabled: false, volcengineApiKey: null });
    expect(service.runtime().volcengineApiKey).toBe("");
  });

  test("allows saving disabled settings without a provider key", async () => {
    const service = new VoiceSettingsService(store() as never, () => "w".repeat(32));
    const saved = await service.save({ ...input, enabled: false });
    expect(saved.enabled).toBe(false);
    expect(saved.defaultProvider).toBe("volcengine");
    expect(saved.providers.volcengine.configured).toBe(false);
  });

  test("disables legacy mock settings and selects Volcengine", async () => {
    const database = store({
      id: "global",
      enabled: true,
      provider: "mock",
      encryptedVolcengineApiKey: null,
      volcengineBaseUrl: "https://openspeech.bytedance.com",
      volcengineSttUrl: null,
      volcengineTtsUrl: null,
      volcengineSttResourceId: "volc.seedasr.sauc.duration",
      volcengineTtsResourceId: "seed-tts-2.0",
      encryptedDeepgramApiKey: null,
      deepgramBaseUrl: "https://api.deepgram.com",
      sttModel: "nova-3",
      ttsModel: "aura-2-thalia-en",
      voice: "alloy",
      language: "en-US",
    });
    const service = new VoiceSettingsService(database as never, () => "z".repeat(32));
    const view = await service.view();
    expect(view.enabled).toBe(false);
    expect(view.defaultProvider).toBe("volcengine");
    expect(Object.keys(view.providers)).toEqual(["volcengine", "deepgram"]);
  });

  test("blank speech fields resolve to the selected provider's defaults", async () => {
    const service = new VoiceSettingsService(store() as never, () => "d".repeat(32));
    const blank = { ...input, enabled: false, sttModel: "", ttsModel: "", voice: "", language: "" };
    await service.save(blank);
    expect(service.runtime("volcengine")).toMatchObject({ ttsModel: "", voice: "zh_female_vv_uranus_bigtts", language: "zh-CN" });
    expect(service.runtime("deepgram")).toMatchObject({ ttsModel: "aura-2-thalia-en", voice: "alloy", language: "en-US" });
    const view = await service.view();
    expect(view).toMatchObject({ sttModel: "", ttsModel: "", voice: "", language: "" });
  });

  test("explicit overrides win over provider defaults", async () => {
    const service = new VoiceSettingsService(store() as never, () => "o".repeat(32));
    await service.save({ ...input, enabled: false, voice: "zh_male_custom", language: "en-US", ttsModel: "", sttModel: "" });
    expect(service.runtime("volcengine")).toMatchObject({ voice: "zh_male_custom", language: "en-US" });
  });

  test("Deepgram defaults persisted by earlier builds are read back as automatic", async () => {
    const database = store({
      id: "global",
      enabled: false,
      provider: "volcengine",
      encryptedVolcengineApiKey: null,
      volcengineBaseUrl: "https://openspeech.bytedance.com",
      volcengineSttUrl: null,
      volcengineTtsUrl: null,
      volcengineSttResourceId: "volc.seedasr.sauc.duration",
      volcengineTtsResourceId: "seed-tts-2.0",
      encryptedDeepgramApiKey: null,
      deepgramBaseUrl: "https://api.deepgram.com",
      sttModel: "nova-3",
      ttsModel: "aura-2-thalia-en",
      voice: "alloy",
      language: "en-US",
    });
    const service = new VoiceSettingsService(database as never, () => "l".repeat(32));
    await service.load();
    expect(service.runtime("volcengine")).toMatchObject({ ttsModel: "", voice: "zh_female_vv_uranus_bigtts", language: "zh-CN" });
  });
});
