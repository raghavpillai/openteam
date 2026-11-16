import type {
  InferenceModelView,
  ServerInferenceSettings,
  ServerSettingsView,
} from "../../../packages/contracts/src/inference";
import type {
  TranscriptionSettingsInput,
  TranscriptionSettingsView,
} from "../../../packages/contracts/src/transcription";

/** Deterministic setup endpoints for the native and desktop UI regressions.
 * OpenRouter is connected with one saved model; OpenAI rejects every key.
 * Keep HTTP methods strict: accepting PATCH here hid a broken iOS voice save. */
export class ServerSetupFixture {
  inference: ServerInferenceSettings = {
    providerId: "openrouter",
    modelId: "qa-saved-model",
    reasoning: "off",
  };
  saves: ServerInferenceSettings[] = [];
  tests: ServerInferenceSettings[] = [];
  voice: TranscriptionSettingsView = {
    enabled: false,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    language: "",
    hasApiKey: false,
    configured: false,
  };

  settings(provider = this.inference.providerId): ServerSettingsView {
    const models: InferenceModelView[] =
      provider === "openrouter"
        ? [
            {
              providerId: provider,
              modelId: "qa-saved-model",
              name: "Saved QA model",
              reasoning: false,
              reasoningLevels: ["off"],
              defaultReasoningLevel: "off",
              contextWindow: 128000,
              maxTokens: 4096,
              recommended: true,
            },
          ]
        : [];
    return {
      inference: { ...this.inference },
      providers: ["openrouter", "openai"].map((id) => ({
        id,
        name: id === "openrouter" ? "OpenRouter" : "OpenAI",
        custom: false,
        authMethods: [{ type: "api_key", label: "API key", subscription: false }],
        connected: id === "openrouter",
        authType: id === "openrouter" ? "api_key" : null,
        authSource: null,
        modelCount: id === "openrouter" ? 1 : 0,
      })),
      models,
      modelProviderId: provider,
    };
  }

  handle(path: string, method: string, input: unknown, url: URL): Response | undefined {
    if (path === "/api/v0/server-settings" && method === "GET") {
      return Response.json(this.settings(url.searchParams.get("provider") ?? undefined));
    }
    if (path === "/api/v0/server-settings/inference" && method === "PATCH") {
      const chosen = input as ServerInferenceSettings;
      const model = this.settings(chosen.providerId).models.find(
        (m) => m.modelId === chosen.modelId
      );
      if (!model || !model.reasoningLevels.includes(chosen.reasoning)) {
        return Response.json(
          { message: "Choose a model and supported reasoning effort." },
          { status: 400 }
        );
      }
      this.inference = { ...chosen };
      this.saves.push({ ...chosen });
      return Response.json(this.settings(chosen.providerId));
    }
    if (path === "/api/v0/server-settings/inference/test" && method === "POST") {
      this.tests.push({ ...this.inference });
      return Response.json({
        ok: true,
        providerId: this.inference.providerId,
        modelId: this.inference.modelId,
        latencyMs: 12,
      });
    }
    if (path === "/api/v0/inference-providers/openai/auth-sessions" && method === "POST") {
      return Response.json(
        { error: { message: "OpenAI didn't accept that key. Check it and try again." } },
        { status: 400 }
      );
    }
    if (path === "/api/v0/server-settings/transcription") {
      if (method === "GET") return Response.json(this.voice);
      if (method === "PUT") {
        const { apiKey, ...settings } = input as TranscriptionSettingsInput;
        const same =
          settings.provider === this.voice.provider && settings.baseUrl === this.voice.baseUrl;
        if (!same && this.voice.hasApiKey && apiKey === undefined)
          return Response.json({ message: "Enter a replacement key or explicitly delete the saved key before changing the transcription endpoint." }, { status: 400 });
        const hasApiKey =
          typeof apiKey === "string"
            ? Boolean(apiKey)
            : apiKey === null
              ? false
              : same && this.voice.hasApiKey;
        this.voice = {
          ...settings,
          hasApiKey,
          apiKeySuffix: hasApiKey ? typeof apiKey === "string" && apiKey.length > 4 ? apiKey.slice(-4) : this.voice.apiKeySuffix ?? null : null,
          configured:
            settings.enabled &&
            Boolean(settings.baseUrl && settings.model) &&
            (settings.provider === "openai-compatible" || hasApiKey),
        };
        return Response.json(this.voice);
      }
      return Response.json({ message: "Use PUT to save voice settings." }, { status: 405 });
    }
    if (path === "/api/v0/server-settings/transcription/check" && method === "POST") {
      return Response.json({ level: "pass", status: "ready", detail: "Voice notes are ready." });
    }
  }
}
