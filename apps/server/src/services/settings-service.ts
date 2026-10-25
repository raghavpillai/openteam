import {
  ApiError,
  type InferenceProviderAuthSessionView,
  type InferenceTestResult,
  serverInferenceSettings,
  type ServerInferenceSettings,
  type ServerSettingsView,
} from "@openteam/contracts";
import type { AgentDataStore } from "@openteam/messaging";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { parseTaskConfiguration } from "@openteam/contracts/task-configuration";
import { serviceEffect } from "./service-utils";
const CONNECTION_CHECK_TIMEOUT_MS = 60_000;

const parseInferenceInput = (input: unknown): ServerInferenceSettings => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_inference_settings", "Inference settings are required");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.providerId !== "string" || typeof value.modelId !== "string") {
    throw new ApiError(
      400,
      "invalid_inference_settings",
      "providerId, modelId, and reasoning are required"
    );
  }
  try {
    return serverInferenceSettings(value.providerId, value.modelId, value.reasoning);
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_inference_settings",
      error instanceof Error ? error.message : String(error)
    );
  }
};

export class SettingsService {
  constructor(
    private readonly agentData: AgentDataStore,
    private readonly computerJson: <T = { ok: true }>(path: string, init: RequestInit) => Promise<T>
  ) {}
  rootSettings = () => serviceEffect(() => this.agentData.loadRootSettingsForClient());

  taskSettings = () => serviceEffect(() => this.agentData.loadTaskConfiguration());

  updateTaskSettings = (input: unknown) =>
    serviceEffect(async () => {
      let configuration;
      try {
        configuration = parseTaskConfiguration(input);
      } catch (error) {
        throw new ApiError(400, "invalid_task_settings", (error as Error).message);
      }
      for (const profile of configuration.executorProfiles)
        await this.computerJson("/v1/inference/settings/verify", {
          method: "POST",
          body: JSON.stringify(profile),
        });
      return this.agentData.writeTaskConfiguration(configuration);
    });

  serverSettings = (providerId?: string) =>
    serviceEffect(async (): Promise<ServerSettingsView> => {
      const inference = await this.agentData.loadInferenceSettings({ allowUnconfigured: true });
      const selectedProvider = providerId ?? inference.providerId;
      const query = new URLSearchParams({ provider: selectedProvider });
      const catalog = await this.computerJson<
        Pick<ServerSettingsView, "providers" | "models" | "modelProviderId">
      >(`/v1/inference/providers?${query}`, { method: "GET" });
      return { inference, ...catalog };
    });

  updateInferenceSettings = (input: unknown) =>
    serviceEffect(async (): Promise<ServerInferenceSettings> => {
      const settings = parseInferenceInput(input);
      await this.computerJson(COMPUTER_API_PATHS.inferenceSettingsVerify, {
        method: "POST",
        body: JSON.stringify(settings),
      });
      return this.agentData.writeInferenceSettings(settings);
    });

  /** Sends one tiny request to the model, so a sign-in is proven rather than assumed. */
  testInference = (input: unknown) =>
    serviceEffect(async (): Promise<InferenceTestResult> => {
      // No body, or an empty one, tests the saved model.
      const empty =
        input === null ||
        input === undefined ||
        (typeof input === "object" && Object.keys(input).length === 0);
      const settings = empty
        ? await this.agentData.loadInferenceSettings({ allowUnconfigured: true })
        : parseInferenceInput(input);
      if (!settings.modelId) {
        throw new ApiError(409, "inference_not_configured", "Choose a model before testing it.");
      }
      const { providerId, modelId } = settings;
      const startedAt = performance.now();
      try {
        await this.computerJson(COMPUTER_API_PATHS.inferenceSettingsVerify, {
          method: "POST",
          body: JSON.stringify(settings),
        });
        await this.computerJson(COMPUTER_API_PATHS.inference, {
          method: "POST",
          body: JSON.stringify({
            kind: "connection-check",
            instructions:
              "You are checking that a model connection works. Follow the request exactly.",
            prompt: "Reply with the single word OK.",
            timeoutMs: CONNECTION_CHECK_TIMEOUT_MS,
            model: `${providerId}/${modelId}`,
            reasoning: settings.reasoning,
          }),
          signal: AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS + 15_000),
        });
        return {
          ok: true,
          providerId,
          modelId,
          latencyMs: Math.round(performance.now() - startedAt),
        };
      } catch (error) {
        return {
          ok: false,
          providerId,
          modelId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

  startInferenceProviderAuth = (providerId: string, authType: "api_key" | "oauth") =>
    serviceEffect(() =>
      this.computerJson<InferenceProviderAuthSessionView>(
        `/v1/inference/providers/${encodeURIComponent(providerId)}/auth-sessions`,
        { method: "POST", body: JSON.stringify({ authType }) }
      )
    );

  inferenceProviderAuthSession = (sessionId: string) =>
    serviceEffect(() =>
      this.computerJson<InferenceProviderAuthSessionView>(
        `/v1/inference/auth-sessions/${encodeURIComponent(sessionId)}`,
        { method: "GET" }
      )
    );

  respondToInferenceProviderAuth = (sessionId: string, promptId: string, value: string) =>
    serviceEffect(() =>
      this.computerJson<InferenceProviderAuthSessionView>(
        `/v1/inference/auth-sessions/${encodeURIComponent(sessionId)}/respond`,
        { method: "POST", body: JSON.stringify({ promptId, value }) }
      )
    );

  cancelInferenceProviderAuth = (sessionId: string) =>
    serviceEffect(() =>
      this.computerJson(`/v1/inference/auth-sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      })
    );

  disconnectInferenceProvider = (providerId: string) =>
    serviceEffect(() =>
      this.computerJson(`/v1/inference/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      })
    );

  updateSidebarPreferences = (input: unknown) =>
    serviceEffect(() => this.agentData.writeSidebarPreferences(input));

  activeAgent = () => serviceEffect(() => this.agentData.loadActiveAgentId());

  setActiveAgent = (activeAgentId: string) =>
    serviceEffect(async () => {
      await this.agentData.writeActiveAgentId(activeAgentId);
      return { activeAgentId };
    });
}
