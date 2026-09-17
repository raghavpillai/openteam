import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const runProviderCli = async (args: string[], slowReader = false) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-provider-cli-"));
  directories.push(directory);
  writeFileSync(join(directory, "auth.json"), "{}");
  writeFileSync(join(directory, "models-store.json"), "{}");
  if (slowReader) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/v1/models")
          return new Response(null, { status: 404 });
        return Response.json({
          data: Array.from({ length: 2_000 }, (_, index) => ({ id: `model-${index}` })),
        });
      },
    });
    servers.push(server);
    writeFileSync(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          "output-test": {
            baseUrl: `${server.url.origin}/v1`,
            api: "openai-completions",
            apiKey: "openteam-no-auth",
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
      expect(models.some((model) => model.providerId === providerId)).toBe(false);
    }
    expect(stdout).toEndWith("\n");
  }, 15_000);

  test.each([
    "openai",
    "openai-codex",
    "anthropic",
  ])("keeps %s models unavailable until connected", async (providerId) => {
    expect(JSON.parse(await runProviderCli(["models", providerId]))).toEqual([]);
    expect(JSON.parse(await runProviderCli(["catalog", providerId]))).toMatchObject({
      models: [],
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: providerId,
          configured: false,
          models: 0,
          modelStatus: "disconnected",
        }),
      ]),
    });
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
