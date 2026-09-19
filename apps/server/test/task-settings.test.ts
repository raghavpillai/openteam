import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SettingsService } from "../src/services/settings-service";
import { defaultTaskConfiguration, type TaskConfiguration } from "@openteam/contracts/task-configuration";

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
  const desired = { combinedComputerUse: false, executorProfiles: [profile], defaultExecutorProfile: "quick" };
  await expect(Effect.runPromise(service.updateTaskSettings({ ...desired, executorProfiles: [profile, { ...profile, name: "deep", modelId: "unavailable" }] }))).rejects.toThrow("Model unavailable");
  expect(saved).toEqual(defaultTaskConfiguration());
  expect(verified).toEqual(["available", "unavailable"]);
  await expect(Effect.runPromise(service.updateTaskSettings({ ...desired, defaultExecutorProfile: "missing" }))).rejects.toThrow("default executor profile");
  expect(verified).toHaveLength(2);
  expect(await Effect.runPromise(service.updateTaskSettings(desired))).toEqual(desired);
  expect(await Effect.runPromise(service.taskSettings())).toEqual(desired);
});
