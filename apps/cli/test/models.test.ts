import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { modelUseCommand } from "../src/providers";
import type { RuntimeInferenceSettings } from "../src/runtime-settings";

class ModelRunner implements CommandRunner {
  calls: Array<readonly string[]> = [];
  verificationError: string | undefined;
  models = ["gpt-5.5", "gpt-5.6-sol"].map((modelId) => ({
    providerId: "openai-codex",
    modelId,
    name: modelId,
    reasoning: true,
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningLevel: "medium",
    input: ["text", "image"],
    contextWindow: 272000,
    maxTokens: 128000,
  }));
  run(_command: string, args: readonly string[], _options?: RunOptions): RunResult {
    this.calls.push(args);
    if (args[0] === "compose" && args[1] === "version") {
      return { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" };
    }
    if (args.includes("verify") && this.verificationError) {
      return { status: 1, stdout: "", stderr: this.verificationError };
    }
    if (args.includes("catalog")) {
      return { status: 0, stdout: JSON.stringify({ models: this.models }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-model-test-"));
  const paths = installationPaths(directory);
  const environment = createEnvironment({ version: "1.2.3" });
  const controlToken = parseEnvironment(environment).get("OPENTEAM_CONTROL_TOKEN");
  const state = {
    selected: {
      providerId: "openai-codex",
      modelId: "gpt-5.5",
      reasoning: "high",
    } as RuntimeInferenceSettings,
    reads: 0,
    writes: [] as RuntimeInferenceSettings[],
    queryProviders: [] as Array<string | null>,
    readStatus: 200,
    writeStatus: 200,
    invalidRead: false,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${controlToken}`) {
        return Response.json({ error: { message: "Incorrect test token" } }, { status: 401 });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/v0/internal/server-settings") {
        state.reads++;
        state.queryProviders.push(url.searchParams.get("provider"));
        if (state.readStatus !== 200)
          return Response.json(
            { error: { message: "Settings unavailable" } },
            { status: state.readStatus }
          );
        return Response.json(state.invalidRead ? {} : { inference: state.selected });
      }
      if (
        request.method === "PATCH" &&
        url.pathname === "/api/v0/internal/server-settings/inference"
      ) {
        const input = (await request.json()) as RuntimeInferenceSettings;
        state.writes.push(input);
        if (state.writeStatus !== 200)
          return Response.json(
            { error: { message: "Model cannot be selected" } },
            { status: state.writeStatus }
          );
        state.selected = input;
        return Response.json(input);
      }
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileAtomic(
    paths.environment,
    replaceEnvironmentValue(environment, "OPENTEAM_API_PORT", String(server.port))
  );
  writeFileAtomic(
    paths.compose,
    "name: openteam\nservices:\n  computer:\n    image: example/computer\n"
  );
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.test/compose.yaml",
    installedAt: now,
    updatedAt: now,
  });
  return { paths, state, runner: new ModelRunner() };
};

describe("Codex model selection", () => {
  test("switches the model while preserving reasoning when --thinking is omitted", async () => {
    const { paths, runner, state } = fixture();
    await modelUseCommand(paths, runner, { providerId: "openai-codex", modelId: "gpt-5.6-sol" });
    expect(state.writes).toEqual([
      { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "high" },
    ]);
    expect(state.selected.modelId).toBe("gpt-5.6-sol");
    expect(state.queryProviders).toEqual(["openai-codex"]);
    expect(runner.calls.find((args) => args.includes("verify"))?.slice(-3)).toEqual([
      "verify",
      "openai-codex",
      "gpt-5.6-sol",
    ]);
  });

  test.each([
    "Inference provider openai-codex is not authenticated",
  ])("rejects failed verification before changing settings: %s", async (error) => {
    const { paths, runner, state } = fixture();
    runner.verificationError = error;
    await expect(
      modelUseCommand(paths, runner, { providerId: "openai-codex", modelId: "gpt-5.6-sol" })
    ).rejects.toThrow(error);
    expect(state.reads).toBe(0);
    expect(state.writes).toHaveLength(0);
    expect(state.selected.modelId).toBe("gpt-5.5");
  });
});
