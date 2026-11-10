import type { VoiceProviderId } from "@openteam/contracts";
import { DeepgramVoiceProvider } from "./voice-providers/deepgram";
import { VolcengineVoiceProvider } from "./voice-providers/volcengine";
import type { VoiceProvider } from "./voice-provider";
import type { VoiceRuntimeSettings } from "./voice-settings";

export class VoiceProviderRegistry {
  constructor(private readonly settings: (provider: VoiceProviderId) => VoiceRuntimeSettings) {}

  get(id: VoiceProviderId): VoiceProvider {
    const settings = this.settings(id);
    if (id === "deepgram") return new DeepgramVoiceProvider({ apiKey: settings.deepgramApiKey, baseUrl: settings.deepgramBaseUrl, model: settings.sttModel, ttsModel: settings.ttsModel });
    return new VolcengineVoiceProvider({
      apiKey: settings.volcengineApiKey,
      baseUrl: settings.volcengineBaseUrl,
      sttUrl: settings.volcengineSttUrl,
      ttsUrl: settings.volcengineTtsUrl,
      sttResourceId: settings.volcengineSttResourceId,
      ttsResourceId: settings.volcengineTtsResourceId,
      sttModel: settings.sttModel,
      ttsModel: settings.ttsModel,
      voice: settings.voice,
    });
  }
}
