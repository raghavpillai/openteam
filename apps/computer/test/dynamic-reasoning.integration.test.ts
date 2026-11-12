import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type PiReasoningLevel } from "@openteam/contracts";
import { ChatProviderRegistry } from "../src/chat-provider-registry";
import { createModelRuntime } from "../src/model-runtime";
import { reasoningCapabilities } from "../src/reasoning-capabilities";
import { inferenceReasoningOptions } from "../src/runtime/reasoning";

test.each([
  [
    {
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
      mandatory: true,
      default_effort: "high",
    },
    ["low", "medium", "high", "xhigh", "max"],
  ],
  [{ supported_efforts: null }, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
  [{ supported_efforts: ["none", "high"], default_effort: "none" }, ["off", "high"]],
  [{ mandatory: true }, []],
  [undefined, []],
] as const)("discover, validate, restart and serialize OpenRouter efforts: %j", async (metadata, levels) => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-dynamic-reasoning-"));
  try {
    const modelsPath = join(directory, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({ providers: { openrouter: { baseUrl: "https://offline.invalid/api/v1" } } })
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openrouter", async () => ({
      type: "api_key",
      key: "synthetic-openrouter-key",
    }));
    const restart = () =>
      createModelRuntime({
        credentials,
        modelsPath,
        modelsStorePath: join(directory, "models-store.json"),
        allowModelNetwork: false,
      });
    let runtime = await restart();
    const id = "author/not-in-any-bundled-registry";
    expect(runtime.getModel("openrouter", id)).toBeUndefined();
    let reasoning: unknown = metadata;
    const registry = new ChatProviderRegistry(() => runtime, modelsPath, (async (url) => {
      if (String(url).endsWith("/endpoints")) return Response.json({ data: { endpoints: [] } });
      return Response.json({
        data: [
          {
            id,
            architecture: { output_modalities: ["text"] },
            supported_parameters: ["tools", "reasoning"],
            reasoning,
          },
        ],
      });
    }) as typeof fetch);
    const [discovered] = (await registry.catalog("openrouter")).models;
    expect(reasoningCapabilities(discovered!).reasoningLevels).toEqual([...levels]);
    for (const level of (levels.length ? levels : ["off"]) as readonly PiReasoningLevel[]) {
      await registry.verify({ providerId: "openrouter", modelId: id, reasoning: level });
      const saved = JSON.parse(await readFile(modelsPath, "utf8")).providers.openrouter.models[0];
      runtime = await restart();
      const restored = runtime.getModel("openrouter", id)!;
      expect(restored).toBeDefined();
      expect(restored.thinkingLevelMap).toEqual(saved.thinkingLevelMap);
      expect(reasoningCapabilities(restored).reasoningLevels).toEqual([...levels]);
      const requests: Record<string, unknown>[] = [];
      const result = await runtime.completeSimple(
        restored,
        { messages: [{ role: "user", content: "offline request", timestamp: 0 }] },
        {
          ...inferenceReasoningOptions(restored, level),
          maxRetries: 0,
          fetch: (async (_url, init) => {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer synthetic-openrouter-key"
            );
            requests.push(JSON.parse(await new Response(init?.body).text()));
            return Response.json({ error: { message: "Captured offline" } }, { status: 400 });
          }) as typeof fetch,
        }
      );
      expect(result.stopReason).toBe("error");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.model).toBe(id);
      if (levels.length)
        expect(requests[0]!.reasoning).toEqual({ effort: level === "off" ? "none" : level });
      else expect(requests[0]).not.toHaveProperty("reasoning");
    }
    // Fresh capabilities supersede the real runtime's persisted snapshot.
    reasoning = { supported_efforts: ["high"], mandatory: true, default_effort: "high" };
    await expect(
      registry.verify({ providerId: "openrouter", modelId: id, reasoning: "max" })
    ).rejects.toThrow("Choose one of: high");
    await registry.verify({ providerId: "openrouter", modelId: id, reasoning: "high" });
    runtime = await restart();
    expect(reasoningCapabilities(runtime.getModel("openrouter", id)!).reasoningLevels).toEqual([
      "high",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
