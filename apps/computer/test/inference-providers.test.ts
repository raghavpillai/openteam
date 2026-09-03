import { describe, expect, test } from "bun:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InferenceProviderService } from "../src/inference-providers";

const eventually = async <T>(read: () => T, matches: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (matches(value)) return value;
    await Bun.sleep(5);
  }
  throw new Error("Expected provider session state was not reached");
};

describe("inference provider service", () => {
  test("exposes catalogs and keeps submitted secrets out of session views", async () => {
    let connected = false;
    let submittedSecret = "";
    const runtime = {
      getProviders: () => [
        {
          id: "test-provider",
          name: "Test Provider",
          auth: {
            apiKey: {
              name: "Test API key",
              login: async (interaction: AuthInteraction) => {
                submittedSecret = await interaction.prompt({
                  type: "secret",
                  message: "API key",
                });
                connected = true;
                return { type: "api_key", key: submittedSecret };
              },
            },
          },
        },
      ],
      getProvider: (id: string) =>
        id === "test-provider"
          ? {
              id,
              name: "Test Provider",
              auth: { apiKey: { name: "Test API key", login: () => undefined } },
            }
          : undefined,
      getModels: (providerId?: string) =>
        !providerId || providerId === "test-provider"
          ? [
              {
                provider: "test-provider",
                id: "test-model",
                name: "Test Model",
                reasoning: true,
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ]
          : [],
      getModel: (providerId: string, modelId: string) =>
        providerId === "test-provider" && modelId === "test-model" ? {} : undefined,
      checkAuth: async () =>
        connected ? { type: "api_key" as const, source: "stored credential" } : undefined,
      login: async (_providerId: string, _type: string, interaction: AuthInteraction) => {
        submittedSecret = await interaction.prompt({ type: "secret", message: "API key" });
        connected = true;
        return { type: "api_key", key: submittedSecret };
      },
      refresh: async () => ({ aborted: false, errors: new Map() }),
      logout: async () => {
        connected = false;
      },
    } as unknown as ModelRuntime;
    const service = new InferenceProviderService(() => runtime, "/does/not/exist/models.json");

    const catalog = await service.catalog("test-provider");
    expect(catalog.providers[0]).toMatchObject({
      id: "test-provider",
      connected: false,
      modelCount: 1,
    });
    expect(catalog.models[0]).toMatchObject({
      providerId: "test-provider",
      modelId: "test-model",
      reasoning: true,
    });

    const started = service.startAuthSession("test-provider", "api_key");
    const waiting = await eventually(
      () => service.authSession(started.id),
      (session) => session.status === "waiting"
    );
    expect(waiting.prompt).toMatchObject({ type: "secret", message: "API key" });
    const promptId = waiting.prompt?.id;
    expect(promptId).toBeString();
    service.respond(started.id, promptId as string, "super-secret-value");
    const complete = await eventually(
      () => service.authSession(started.id),
      (session) => session.status === "connected"
    );
    expect(submittedSecret).toBe("super-secret-value");
    expect(JSON.stringify(complete)).not.toContain("super-secret-value");

    const expiring = service.startAuthSession("test-provider", "api_key");
    await eventually(
      () => service.authSession(expiring.id),
      (session) => session.status === "waiting"
    );
    const internals = service as unknown as {
      sessions: Map<string, { createdAt: number }>;
    };
    const state = internals.sessions.get(expiring.id);
    if (!state) throw new Error("Expected provider session state");
    state.createdAt = Date.now() - 16 * 60_000;
    expect(service.authSession(expiring.id).status).toBe("cancelled");
  });
});
