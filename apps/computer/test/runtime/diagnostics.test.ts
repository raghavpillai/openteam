import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerRuntime } from "../../src/runtime";
import { tempDirs } from "../temp";
const tempDir = tempDirs();

test("diagnostics use the saved selection and leave new installs unconfigured", async () => {
  const root = await tempDir("openteam-diagnostics-");
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as {
    settingsPath: string;
    refreshAuthentication(): Promise<void>;
    modelRuntime: unknown;
    started: boolean;
    resolveModel: (ref: unknown) => unknown;
  };
  internals.settingsPath = join(root, "settings.json");
  internals.started = true;
  const authProviders: string[] = [];
  internals.modelRuntime = {
    checkAuth: async (provider: string) => {
      authProviders.push(provider);
      return { type: "api_key" };
    },
    isUsingSubscription: () => false,
  };
  runtime.start = () => internals.refreshAuthentication();
  await runtime.start();
  expect(runtime.diagnostics.model).toBe("");
  expect(runtime.diagnostics.qualifiedModel).toBe("");
  expect(await runtime.inferenceDiagnostics()).toMatchObject({ ready: true, model: "", authenticated: false });

  const inference = { providerId: "custom", modelId: "saved-model", reasoning: "off" };
  await writeFile(internals.settingsPath, JSON.stringify({ inference }));
  internals.resolveModel = (ref) => {
    expect(ref).toMatchObject({ providerId: "custom", modelId: "saved-model" });
    return { reasoning: false };
  };
  expect(await runtime.inferenceDiagnostics()).toMatchObject({
    inferenceProvider: "custom",
    model: "saved-model",
    reasoning: "off",
  });
  expect(runtime.diagnostics.qualifiedModel).toBe("custom/saved-model");
  expect(authProviders.at(-1)).toBe("custom");

  await writeFile(
    internals.settingsPath,
    JSON.stringify({ inference: { ...inference, modelId: "" } })
  );
  expect(await runtime.inferenceDiagnostics()).toMatchObject({ model: "", authenticated: false });
  expect(runtime.diagnostics.model).toBe("");
});
