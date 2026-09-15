import { ModelSession } from "../../src/model-session";
import type {
  ModelSettingsAPI,
  ModelCatalog,
  TranscriptionDraft,
  TranscriptionView,
} from "../../src/model-settings";
import type { RuntimeInferenceSettings } from "../../src/runtime-settings";
import type { SessionKey } from "../../src/setup-session";

export const modelFixture = () => {
  let inference: RuntimeInferenceSettings = {
    providerId: "example",
    modelId: "reasoner",
    reasoning: "high",
  };
  let transcription: TranscriptionView = {
    enabled: true,
    provider: "openai-compatible",
    baseUrl: "http://audio.test/v1",
    model: "speech-small",
    language: "",
    hasApiKey: true,
    configured: true,
  };
  const calls = {
    inference: [] as RuntimeInferenceSettings[],
    transcription: [] as TranscriptionDraft[],
    discovery: [] as TranscriptionDraft[],
    checks: 0,
  };
  const api: ModelSettingsAPI = {
    async catalog(provider = inference.providerId): Promise<ModelCatalog> {
      return {
        inference: { ...inference },
        modelProviderId: provider,
        providers: [
          { id: "example", name: "Example AI", connected: true, modelCount: 2 },
          { id: "offline", name: "Disconnected AI", connected: false, modelCount: 1 },
        ],
        models: (provider === "example"
          ? ([
              ["reasoner", true],
              ["fast", false],
            ] as const)
          : ([["offline-model", true]] as const)
        ).map(([modelId, reasoning]) => ({
          providerId: provider,
          modelId,
          name: modelId === "reasoner" ? "Reasoner" : modelId,
          reasoning,
          contextWindow: 128000,
          maxTokens: 8192,
        })),
      };
    },
    async transcription() {
      return { ...transcription };
    },
    async saveInference(value) {
      calls.inference.push({ ...value });
      inference = { ...value };
      return { ...inference };
    },
    async saveTranscription(value) {
      calls.transcription.push({ ...value });
      const { apiKey, ...settings } = value;
      const hasApiKey =
        apiKey === undefined
          ? transcription.hasApiKey &&
            value.provider === transcription.provider &&
            value.baseUrl === transcription.baseUrl
          : Boolean(apiKey);
      transcription = {
        ...settings,
        hasApiKey,
        configured:
          value.enabled &&
          Boolean(value.baseUrl && value.model) &&
          (value.provider !== "openai" || hasApiKey),
      };
      return { ...transcription };
    },
    async checkTranscription() {
      calls.checks++;
      return {
        level: "pass",
        detail: "Provider reachable; model available. Send a voice note to verify transcription.",
      };
    },
    async transcriptionModels(value) {
      calls.discovery.push({ ...value });
      return ["speech-large", "speech-small"];
    },
  };
  const session = new ModelSession(
    api,
    "1.2.3",
    (p) => `openteam provider login ${p} --dir /tmp/model-test`
  );
  return { session, api, calls };
};
export const press = (session: ModelSession, name: string, extra: Partial<SessionKey> = {}) =>
  session.handle("", { name, ...extra });
export const focused = (session: ModelSession) => {
  const view = session.view();
  const row = view.rows[view.cursorRow];
  return row && "id" in row ? row.id : undefined;
};
export const focus = async (session: ModelSession, id: string) => {
  for (let i = 0; i < session.rows().length + 1; i++) {
    if (focused(session) === id) return;
    await press(session, "down");
  }
  throw new Error(`Could not focus ${id}`);
};
export const activate = async (session: ModelSession, id: string) => {
  await focus(session, id);
  return press(session, "return");
};
export const edit = async (session: ModelSession, id: string, value: string) => {
  await activate(session, id);
  await press(session, "u", { ctrl: true });
  for (const char of value) await session.handle(char, {});
  await press(session, "return");
};
export const screen = (session: ModelSession, width = 90) => {
  const f = session.frame(width, false);
  return [...f.header, ...f.body, ...f.footer].join("\n");
};
