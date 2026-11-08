import { ApiError, type VoiceProviderId, type VoiceSettingsInput, type VoiceSettingsView } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ID = "global";
const DEFAULT_VOLCENGINE_BASE_URL = "https://openspeech.bytedance.com";
const DEFAULT_VOLCENGINE_STT_RESOURCE_ID = "volc.seedasr.sauc.duration";
const DEFAULT_VOLCENGINE_TTS_RESOURCE_ID = "seed-tts-2.0";
const DEFAULT_DEEPGRAM_BASE_URL = "https://api.deepgram.com";

/**
 * Models, voice and language are stored blank unless the user overrides them.
 * Blank means "use the selected provider's default", resolved per provider in
 * effective(); the two providers have incompatible voice and model identifiers.
 */
const PROVIDER_SPEECH_DEFAULTS: Record<VoiceProviderId, { sttModel: string; ttsModel: string; voice: string; language: string }> = {
  volcengine: { sttModel: "bigmodel", ttsModel: "", voice: "zh_female_vv_uranus_bigtts", language: "zh-CN" },
  deepgram: { sttModel: "nova-3", ttsModel: "aura-2-thalia-en", voice: "alloy", language: "en-US" },
};
// Earlier builds persisted the Deepgram defaults for every provider. Read them back as "automatic".
const LEGACY_STORED_DEFAULTS = {
  sttModel: "nova-3",
  ttsModel: "aura-2-thalia-en",
  voice: "alloy",
  language: "en-US",
} as const;
const unlessLegacy = (value: string, field: keyof typeof LEGACY_STORED_DEFAULTS) =>
  value === LEGACY_STORED_DEFAULTS[field] ? "" : value;

const invalid = (message: string) => new ApiError(400, "invalid_voice_settings", message);

export interface VoiceRuntimeSettings {
  enabled: boolean;
  defaultProvider: VoiceProviderId;
  volcengineApiKey: string;
  volcengineBaseUrl: string;
  volcengineSttUrl: string;
  volcengineTtsUrl: string;
  volcengineSttResourceId: string;
  volcengineTtsResourceId: string;
  deepgramApiKey: string;
  deepgramBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  language: string;
  narrationModel: string;
}

const defaults = (): VoiceRuntimeSettings => ({
  enabled: false,
  defaultProvider: "volcengine",
  volcengineApiKey: "",
  volcengineBaseUrl: DEFAULT_VOLCENGINE_BASE_URL,
  volcengineSttUrl: "",
  volcengineTtsUrl: "",
  volcengineSttResourceId: DEFAULT_VOLCENGINE_STT_RESOURCE_ID,
  volcengineTtsResourceId: DEFAULT_VOLCENGINE_TTS_RESOURCE_ID,
  deepgramApiKey: "",
  deepgramBaseUrl: DEFAULT_DEEPGRAM_BASE_URL,
  sttModel: "",
  ttsModel: "",
  voice: "",
  language: "",
  narrationModel: "",
});

const invalidString = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw invalid(`Voice ${field} is invalid.`);
  return value.trim();
};

const optionalString = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return "";
  return invalidString(value, field, max);
};

const httpUrl = (value: string, field: string): string => {
  if (!value) throw invalid(`Voice ${field} is required.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`Voice ${field} must be a full HTTP or HTTPS URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.toString().includes("@") || url.search || url.hash)
    throw invalid(`Voice ${field} must be an HTTP or HTTPS URL without credentials or query parameters.`);
  return url.toString().replace(/\/+$/, "");
};

const websocketUrl = (value: string, field: string): string => {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`Voice ${field} must be a full WebSocket URL.`);
  }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.toString().includes("@") || url.search || url.hash)
    throw invalid(`Voice ${field} must be a WebSocket URL without credentials or query parameters.`);
  return url.toString().replace(/\/+$/, "");
};

function parseInput(input: unknown): VoiceSettingsInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Voice settings are required.");
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== "boolean") throw invalid("Voice enabled must be a boolean.");
  if (value.defaultProvider !== "deepgram" && value.defaultProvider !== "volcengine")
    throw invalid("Choose a supported voice provider.");

  const parsed: Record<string, unknown> = {
    enabled: value.enabled,
    defaultProvider: value.defaultProvider,
    volcengineBaseUrl: httpUrl(
      invalidString(value.volcengineBaseUrl ?? DEFAULT_VOLCENGINE_BASE_URL, "Volcengine base URL", 500),
      "Volcengine base URL",
    ),
    volcengineSttUrl: websocketUrl(
      invalidString(value.volcengineSttUrl ?? "", "Volcengine STT URL", 500),
      "Volcengine STT URL",
    ),
    volcengineTtsUrl: websocketUrl(
      invalidString(value.volcengineTtsUrl ?? "", "Volcengine TTS URL", 500),
      "Volcengine TTS URL",
    ),
    volcengineSttResourceId: invalidString(
      value.volcengineSttResourceId ?? DEFAULT_VOLCENGINE_STT_RESOURCE_ID,
      "Volcengine STT resource ID",
      200,
    ),
    volcengineTtsResourceId: invalidString(
      value.volcengineTtsResourceId ?? DEFAULT_VOLCENGINE_TTS_RESOURCE_ID,
      "Volcengine TTS resource ID",
      200,
    ),
    deepgramBaseUrl: httpUrl(
      invalidString(value.deepgramBaseUrl ?? DEFAULT_DEEPGRAM_BASE_URL, "Deepgram base URL", 500),
      "Deepgram base URL",
    ),
    sttModel: invalidString(value.sttModel ?? "", "STT model", 200),
    ttsModel: invalidString(value.ttsModel ?? "", "TTS model", 200),
    voice: invalidString(value.voice ?? "", "TTS voice", 200),
    language: invalidString(value.language ?? "", "language", 40),
  };
  const narrationModel = optionalString(value.narrationModel, "narration model", 200);
  if (narrationModel !== undefined) {
    if (narrationModel && narrationModel.indexOf("/") <= 0) throw invalid("Voice narration model must look like provider/model.");
    parsed.narrationModel = narrationModel;
  }

  for (const field of ["volcengineApiKey", "deepgramApiKey"] as const) {
    const key = optionalString(value[field], field, 20_000);
    if (key !== undefined) parsed[field] = key ? key : null;
  }
  return parsed as VoiceSettingsInput;
}

export class VoiceSettingsService {
  private cached: VoiceRuntimeSettings | null = null;

  constructor(
    private readonly prisma: Pick<PrismaClient, "voiceSettings">,
    private readonly secret: () => string | undefined = () => process.env.OPENTEAM_AUTH_SECRET,
  ) {}

  private key(): Buffer {
    const secret = this.secret();
    if (!secret || secret.length < 32)
      throw invalid("The server auth secret must be configured before saving a voice provider key.");
    return createHash("sha256").update(`openteam-voice-settings-v1:${secret}`).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }

  private decrypt(value: string): string {
    try {
      const bytes = Buffer.from(value, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw invalid("A saved voice provider key cannot be decrypted. Save it again in Voice settings.");
    }
  }

  private async read(): Promise<VoiceRuntimeSettings> {
    const row = await this.prisma.voiceSettings.findUnique({ where: { id: ID } });
    if (!row) return defaults();
    const legacyMockProvider = row.provider === "mock";
    return {
      enabled: legacyMockProvider ? false : row.enabled,
      defaultProvider:
        row.provider === "volcengine" || row.provider === "deepgram"
          ? row.provider
          : "volcengine",
      volcengineApiKey: row.encryptedVolcengineApiKey ? this.decrypt(row.encryptedVolcengineApiKey) : "",
      volcengineBaseUrl: row.volcengineBaseUrl,
      volcengineSttUrl: row.volcengineSttUrl ?? "",
      volcengineTtsUrl: row.volcengineTtsUrl ?? "",
      volcengineSttResourceId: row.volcengineSttResourceId,
      volcengineTtsResourceId: row.volcengineTtsResourceId,
      deepgramApiKey: row.encryptedDeepgramApiKey ? this.decrypt(row.encryptedDeepgramApiKey) : "",
      deepgramBaseUrl: row.deepgramBaseUrl,
      sttModel: unlessLegacy(row.sttModel, "sttModel"),
      ttsModel: unlessLegacy(row.ttsModel, "ttsModel"),
      voice: unlessLegacy(row.voice, "voice"),
      language: unlessLegacy(row.language, "language"),
      narrationModel: row.narrationModel,
    };
  }

  async load(): Promise<VoiceRuntimeSettings> {
    this.cached = await this.read();
    return this.cached;
  }

  /** Settings with blank speech fields replaced by the provider's defaults. */
  runtime(provider?: VoiceProviderId): VoiceRuntimeSettings {
    const settings = this.cached ?? defaults();
    const speech = PROVIDER_SPEECH_DEFAULTS[provider ?? settings.defaultProvider];
    return {
      ...settings,
      sttModel: settings.sttModel || speech.sttModel,
      ttsModel: settings.ttsModel || speech.ttsModel,
      voice: settings.voice || speech.voice,
      language: settings.language || speech.language,
    };
  }

  private providerView(settings: VoiceRuntimeSettings, provider: VoiceProviderId): VoiceSettingsView["providers"][VoiceProviderId] {
    const key = provider === "volcengine" ? settings.volcengineApiKey : settings.deepgramApiKey;
    const baseUrl = provider === "volcengine" ? settings.volcengineBaseUrl : settings.deepgramBaseUrl;
    return {
      configured: Boolean(key),
      stt: Boolean(key),
      tts: Boolean(key),
      baseUrl,
      ...(provider === "volcengine"
        ? {
            sttUrl: settings.volcengineSttUrl || null,
            ttsUrl: settings.volcengineTtsUrl || null,
            sttResourceId: settings.volcengineSttResourceId,
            ttsResourceId: settings.volcengineTtsResourceId,
          }
        : {}),
      apiKeySuffix: key.length > 4 ? key.slice(-4) : null,
    };
  }

  async view(): Promise<VoiceSettingsView> {
    const settings = this.cached ?? (await this.load());
    return {
      enabled: settings.enabled,
      defaultProvider: settings.defaultProvider,
      providers: {
        volcengine: this.providerView(settings, "volcengine"),
        deepgram: this.providerView(settings, "deepgram"),
      },
      sttModel: settings.sttModel,
      ttsModel: settings.ttsModel,
      voice: settings.voice,
      language: settings.language,
      narrationModel: settings.narrationModel,
    };
  }

  async save(input: VoiceSettingsInput): Promise<VoiceSettingsView> {
    const parsed = parseInput(input);
    const previous = this.cached ?? (await this.load());
    const next: VoiceRuntimeSettings = {
      enabled: parsed.enabled,
      defaultProvider: parsed.defaultProvider,
      volcengineApiKey:
        parsed.volcengineApiKey === undefined ? previous.volcengineApiKey : parsed.volcengineApiKey ?? "",
      volcengineBaseUrl: parsed.volcengineBaseUrl!,
      volcengineSttUrl: parsed.volcengineSttUrl!,
      volcengineTtsUrl: parsed.volcengineTtsUrl!,
      volcengineSttResourceId: parsed.volcengineSttResourceId!,
      volcengineTtsResourceId: parsed.volcengineTtsResourceId!,
      deepgramApiKey:
        parsed.deepgramApiKey === undefined ? previous.deepgramApiKey : parsed.deepgramApiKey ?? "",
      deepgramBaseUrl: parsed.deepgramBaseUrl!,
      sttModel: parsed.sttModel!,
      ttsModel: parsed.ttsModel!,
      voice: parsed.voice!,
      language: parsed.language!,
      narrationModel: parsed.narrationModel ?? previous.narrationModel,
    };
    if (next.enabled) {
      const key = next.defaultProvider === "volcengine" ? next.volcengineApiKey : next.deepgramApiKey;
      if (!key) throw invalid(`A ${next.defaultProvider} API key is required to enable realtime voice.`);
    }

    const data = {
      id: ID,
      enabled: next.enabled,
      provider: next.defaultProvider,
      encryptedVolcengineApiKey: next.volcengineApiKey ? this.encrypt(next.volcengineApiKey) : null,
      volcengineBaseUrl: next.volcengineBaseUrl,
      volcengineSttUrl: next.volcengineSttUrl || null,
      volcengineTtsUrl: next.volcengineTtsUrl || null,
      volcengineSttResourceId: next.volcengineSttResourceId,
      volcengineTtsResourceId: next.volcengineTtsResourceId,
      encryptedDeepgramApiKey: next.deepgramApiKey ? this.encrypt(next.deepgramApiKey) : null,
      deepgramBaseUrl: next.deepgramBaseUrl,
      sttModel: next.sttModel,
      ttsModel: next.ttsModel,
      voice: next.voice,
      language: next.language,
      narrationModel: next.narrationModel,
    };
    await this.prisma.voiceSettings.upsert({
      where: { id: ID },
      create: data,
      update: data,
    });
    this.cached = next;
    return this.view();
  }

  providerConfigured(provider: VoiceProviderId): boolean {
    const settings = this.runtime(provider);
    return Boolean(provider === "volcengine" ? settings.volcengineApiKey : settings.deepgramApiKey);
  }
}
