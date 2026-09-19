import {
  ApiError,
  type InferenceProviderAuthSessionView,
  serverInferenceSettings,
  type ServerInferenceSettings,
  type ServerSettingsView,
} from "@openteam/contracts";
import type { AgentDataStore } from "@openteam/messaging";
import { parseTaskConfiguration } from "@openteam/contracts/task-configuration";
import { serviceEffect } from "./service-utils";
export class SettingsService {
  constructor(
    private readonly agentData: AgentDataStore,
    private readonly computerJson: <T = { ok: true }>(path: string, init: RequestInit) => Promise<T>
  ) {}
  rootSettings = () => serviceEffect(() => this.agentData.loadRootSettingsForClient());

  taskSettings = () => serviceEffect(() => this.agentData.loadTaskConfiguration());

  updateTaskSettings = (input: unknown) => serviceEffect(async () => {
    let configuration;
    try { configuration = parseTaskConfiguration(input); }
    catch (error) { throw new ApiError(400, "invalid_task_settings", (error as Error).message); }
    for (const profile of configuration.executorProfiles)
      await this.computerJson("/v1/inference/settings/verify", {
        method: "POST", body: JSON.stringify(profile),
      });
    return this.agentData.writeTaskConfiguration(configuration);
  });

  serverSettings = (providerId?: string) =>
    serviceEffect(async (): Promise<ServerSettingsView> => {
      const inference = await this.agentData.loadInferenceSettings();
      const selectedProvider = providerId ?? inference.providerId;
      const query = new URLSearchParams({ provider: selectedProvider });
      const catalog = await this.computerJson<
        Pick<ServerSettingsView, "providers" | "models" | "modelProviderId">
      >(`/v1/inference/providers?${query}`, { method: "GET" });
      return { inference, ...catalog };
    });

  updateInferenceSettings = (input: unknown) =>
    serviceEffect(async (): Promise<ServerInferenceSettings> => {
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
      let settings: ServerInferenceSettings;
      try {
        settings = serverInferenceSettings(value.providerId, value.modelId, value.reasoning);
      } catch (error) {
        throw new ApiError(
          400,
          "invalid_inference_settings",
          error instanceof Error ? error.message : String(error)
        );
      }
      await this.computerJson("/v1/inference/settings/verify", {
        method: "POST",
        body: JSON.stringify(settings),
      });
      return this.agentData.writeInferenceSettings(settings);
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
