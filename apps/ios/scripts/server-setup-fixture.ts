import type {
  InferenceModelView,
  InferenceProviderAuthSessionView,
  PiReasoningLevel,
  ServerInferenceSettings,
  ServerSettingsView,
} from "../../../packages/contracts/src/inference";
import type {
  TranscriptionSettingsInput,
  TranscriptionSettingsView,
} from "../../../packages/contracts/src/transcription";

/** Deterministic setup endpoints for the native and desktop UI regressions.
 * Keep HTTP methods strict: accepting PATCH here hid a broken iOS voice save. */
export class ServerSetupFixture {
  constructor(private readonly modelSettings = false) {}
  inference: ServerInferenceSettings = {
    providerId: "openrouter",
    modelId: "qa-saved-model",
    reasoning: "off",
  };
  largeModelCatalog = false;
  saves: ServerInferenceSettings[] = [];
  tests: ServerInferenceSettings[] = [];
  private openaiConnected = false;
  private session: InferenceProviderAuthSessionView | null = null;
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
    const extras: InferenceModelView[] = this.largeModelCatalog
      ? Array.from({ length: 20 }, (_, index) => {
          const maker = index % 2 ? "Anthropic" : "OpenAI";
          return {
            providerId: "openrouter",
            modelId: `${maker.toLowerCase()}/qa-model-${index}`,
            name: `${maker}: QA model ${index}`,
            reasoning: true,
            reasoningLevels: ["off", "low", "high"],
            defaultReasoningLevel: "low",
            contextWindow: 128000,
            maxTokens: 4096,
          };
        })
      : [];
    return {
      inference: { ...this.inference },
      providers: ["openrouter", "openai"].map((id) => ({
        id,
        name: id === "openrouter" ? "OpenRouter" : "OpenAI",
        custom: false,
        authMethods: [{ type: "api_key", label: "API key", subscription: false }],
        connected: id === "openrouter" || this.openaiConnected,
        authType: id === "openrouter" || this.openaiConnected ? "api_key" : null,
        authSource: null,
        modelCount:
          id === "openrouter"
            ? (this.modelSettings ? 2 : 1) + extras.length
            : this.openaiConnected
              ? 1
              : 0,
      })),
      models:
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
              ...(this.modelSettings
                ? [
                    {
                      providerId: provider,
                      modelId: "qa-reasoning-model",
                      name: "Reasoning QA model",
                      reasoning: true,
                      reasoningLevels: ["off", "low", "high"] as PiReasoningLevel[],
                      defaultReasoningLevel: "low" as const,
                      contextWindow: 128000,
                      maxTokens: 4096,
                    },
                  ]
                : []),
              ...extras,
            ]
          : this.openaiConnected
            ? [
                {
                  providerId: provider,
                  modelId: "qa-openai-model",
                  name: "OpenAI QA model",
                  reasoning: true,
                  reasoningLevels: ["low", "high"],
                  defaultReasoningLevel: "low",
                  contextWindow: 128000,
                  maxTokens: 4096,
                  recommended: true,
                },
              ]
            : [],
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
      if (this.modelSettings) {
        this.session = {
          id: "qa-model-key",
          providerId: "openai",
          authType: "api_key",
          status: "waiting",
          prompt: { id: "qa-key-prompt", type: "secret", message: "API key" },
          authorizationUrl: null,
          deviceCode: null,
          messages: [],
          error: null,
        };
        return Response.json(this.session);
      }
      return Response.json(
        { error: { message: "OpenAI didn't accept that key. Check it and try again." } },
        { status: 400 }
      );
    }
    if (
      this.modelSettings &&
      path === "/api/v0/inference-provider-auth-sessions/qa-model-key/respond" &&
      method === "POST"
    ) {
      const answer = input as { promptId: string; value: string };
      if (!this.session || answer.promptId !== "qa-key-prompt" || answer.value !== "qa-model-key") {
        return Response.json({ message: "The fixture key was refused." }, { status: 400 });
      }
      this.openaiConnected = true;
      this.session = { ...this.session, status: "connected", prompt: null };
      return Response.json(this.session);
    }
    if (this.modelSettings && path === "/api/v0/inference-provider-auth-sessions/qa-model-key") {
      if (method === "DELETE" && this.session)
        this.session = { ...this.session, status: "cancelled", prompt: null };
      if ((method === "GET" || method === "DELETE") && this.session)
        return Response.json(this.session);
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
