import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const runProviderCli = async (args: string[], slowReader = false) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-provider-cli-"));
  directories.push(directory);
  writeFileSync(join(directory, "auth.json"), "{}");
  writeFileSync(join(directory, "models-store.json"), "{}");
  if (slowReader) {
    writeFileSync(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          "output-test": {
            baseUrl: "https://example.test/v1",
            api: "openai-completions",
            models: Array.from({ length: 2_000 }, (_, index) => ({
              id: `model-${index}`,
              name: `Output test ${index} ${"x".repeat(1_024)}`,
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 8_192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          },
        },
      })
    );
  }
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({
      inference: { providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "high" },
    })
  );
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../src/provider-cli.ts"), ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      PI_OFFLINE: "1",
      OPENTEAM_PI_AGENT_DIR: directory,
      OPENTEAM_AGENT_DATA_ROOT: directory,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Delay reading to exercise pipe backpressure, as when Docker forwards a large catalog.
  if (slowReader) await Bun.sleep(500);
  const stdoutText = new Response(child.stdout).text();
  const stderrText = new Response(child.stderr).text();
  const [status, stdout, stderr] = await Promise.all([child.exited, stdoutText, stderrText]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  return stdout;
};

describe("provider CLI JSON output", () => {
  test("writes the complete model catalog through a slow pipe", async () => {
    const stdout = await runProviderCli(["models"], true);
    const models = JSON.parse(stdout) as Array<{ providerId: string; modelId: string }>;
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(2_000_000);
    expect(models.filter((model) => model.providerId === "output-test")).toHaveLength(2_000);
    for (const providerId of ["openai", "openai-codex", "anthropic"]) {
      expect(models.some((model) => model.providerId === providerId)).toBe(true);
    }
    expect(stdout).toEndWith("\n");
  }, 15_000);

  test.each([
    "openai",
    "openai-codex",
    "anthropic",
  ])("lists only %s models without credentials", async (providerId) => {
    const models = JSON.parse(await runProviderCli(["models", providerId])) as Array<{
      providerId: string;
      modelId: string;
      input: string[];
      contextWindow: number;
    }>;
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.providerId).toBe(providerId);
      expect(model.modelId.length).toBeGreaterThan(0);
      expect(model.input).toContain("text");
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  test("writes the provider catalog and active selection as JSON", async () => {
    const providers = JSON.parse(await runProviderCli(["providers"])) as Array<{ id: string }>;
    for (const id of ["openai", "openai-codex", "anthropic"]) {
      expect(providers.some((provider) => provider.id === id)).toBe(true);
    }
    expect(JSON.parse(await runProviderCli(["selection"]))).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.5",
      reasoning: "high",
    });
  });
});
