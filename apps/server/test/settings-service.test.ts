import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SettingsService } from "../src/services/settings-service";
import { defaultServerInferenceSettings } from "@openteam/contracts";
import { defaultTaskConfiguration, type TaskConfiguration } from "@openteam/contracts/task-configuration";

test("unconfigured installations can browse models without saving a selection", async () => {
  let saves = 0;
  const service = new SettingsService(
    {
      loadInferenceSettings: async (options: unknown) => {
        expect(options).toEqual({ allowUnconfigured: true });
        return defaultServerInferenceSettings();
      },
      writeInferenceSettings: async () => {
        saves++;
      },
    } as never,
    (async (path: string) => {
      expect(path).toBe("/v1/inference/providers?provider=openai-codex");
      return { providers: [], models: [], modelProviderId: "openai-codex" };
    }) as never
  );

  const settings = await Effect.runPromise(service.serverSettings());
  expect(settings.inference.modelId).toBe("");
  expect(settings.models).toEqual([]);
  await expect(
    Effect.runPromise(service.updateInferenceSettings(settings.inference))
  ).rejects.toThrow("Invalid inference model");
  expect(saves).toBe(0);
});

test("model tests verify the choice, then send one minimal request", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const service = new SettingsService(
    {
      loadInferenceSettings: async () => ({
        providerId: "openai",
        modelId: "gpt-5.6",
        reasoning: "low",
      }),
    } as never,
    (async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return path === "/v1/infer" ? { text: "OK" } : { settings: {} };
    }) as never
  );

  const result = await Effect.runPromise(service.testInference(null));
  expect(result).toMatchObject({ ok: true, providerId: "openai", modelId: "gpt-5.6" });
  expect(calls.map((call) => call.path)).toEqual(["/v1/inference/settings/verify", "/v1/infer"]);
  // An empty JSON body also means the saved model.
  expect(await Effect.runPromise(service.testInference({}))).toMatchObject({ ok: true });
  expect(calls[1]?.body).toMatchObject({
    kind: "connection-check",
    model: "openai/gpt-5.6",
    reasoning: "low",
  });
});

test("model tests report provider failures instead of throwing", async () => {
  const service = new SettingsService(
    {} as never,
    (async (path: string) => {
      if (path === "/v1/infer") throw new Error("Incorrect API key provided");
      return { settings: {} };
    }) as never
  );

  const result = await Effect.runPromise(
    service.testInference({ providerId: "openai", modelId: "gpt-5.6", reasoning: "low" })
  );
  expect(result).toEqual({
    ok: false,
    providerId: "openai",
    modelId: "gpt-5.6",
    error: "Incorrect API key provided",
  });
});

test("Task settings verify every model before changing the saved configuration", async () => {
  let saved = defaultTaskConfiguration();
  const verified: string[] = [];
  const service = new SettingsService({
    loadTaskConfiguration: async () => saved,
    writeTaskConfiguration: async (value: TaskConfiguration) => (saved = value),
  } as never, (async (path: string, init: RequestInit) => {
    expect(path).toBe("/v1/inference/settings/verify");
    const profile = JSON.parse(init.body as string);
    verified.push(profile.modelId);
    if (profile.modelId === "unavailable") throw new Error("Model unavailable");
    return { ok: true };
  }) as never);
  const profile = { name: "quick", description: "Small jobs", providerId: "openai", modelId: "available", reasoning: "low" as const };
  const desired = { executorProfiles: [profile], defaultExecutorProfile: "quick" };
  await expect(Effect.runPromise(service.updateTaskSettings({ ...desired, executorProfiles: [profile, { ...profile, name: "deep", modelId: "unavailable" }] }))).rejects.toThrow("Model unavailable");
  expect(saved).toEqual(defaultTaskConfiguration());
  expect(verified).toEqual(["available", "unavailable"]);
  await expect(Effect.runPromise(service.updateTaskSettings({ ...desired, defaultExecutorProfile: "missing" }))).rejects.toThrow("default executor profile");
  expect(verified).toHaveLength(2);
  expect(await Effect.runPromise(service.updateTaskSettings(desired))).toEqual(desired);
  expect(await Effect.runPromise(service.taskSettings())).toEqual(desired);
});
