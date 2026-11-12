import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ComputerRuntime } from "../src/runtime";
import { InferenceProviderService } from "../src/inference-providers";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../src/bot-compaction";

// Opt-in live integration check. Point it at a running Magpie with a vision model:
// MAGPIE_BASE_URL=http://127.0.0.1:3425/v1 MAGPIE_MODEL=provider/model bun run scripts/test-magpie-capabilities.ts
const baseUrl = (process.env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425/v1").replace(/\/+$/, "");
const modelId = process.env.MAGPIE_MODEL;
assert.ok(modelId, "Set MAGPIE_MODEL to a vision-capable model listed by Magpie");
const root = resolve(process.env.MAGPIE_TEST_OUTPUT ?? "output/magpie-capabilities");
const timeoutMs = Number(process.env.MAGPIE_TEST_TIMEOUT_MS ?? 90000);
assert.ok(
  Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
  "MAGPIE_TEST_TIMEOUT_MS must be a positive integer"
);
await mkdir(root, { recursive: true, mode: 0o700 });
// Invalidate an earlier run before discovery or inference can fail.
await writeFile(join(root, "result.json"), JSON.stringify({ modelId, success: false }));
const token = process.env.MAGPIE_API_KEY ?? "magpie";
const response = await fetch(`${baseUrl}/models`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000),
});
assert.ok(response.ok, `Magpie model discovery returned ${response.status}`);
const body = (await response.json()) as any;
const advertised = body.data.find((entry: any) => entry.id === modelId);
assert.ok(advertised, "MAGPIE_MODEL must be listed by this Magpie instance");
assert.ok(
  (advertised.input_modalities ?? advertised.modalities?.input)?.includes("image"),
  "Magpie must advertise image input"
);
const modelsPath = join(root, "models.json");
const definition = {
  id: modelId,
  name: modelId,
  api: "openai-completions",
  baseUrl,
  reasoning: advertised.reasoning === true,
  thinkingLevelMap: { off: "none" },
  input: ["text"],
  contextWindow: 16384,
  maxTokens: 512,
  compat: { maxTokensField: "max_tokens", supportsStore: false },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
await writeFile(
  modelsPath,
  JSON.stringify({
    providers: {
      magpie: { api: "openai-completions", baseUrl, apiKey: token, models: [definition] },
    },
  }),
  { mode: 0o600 }
);
const create = async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath,
    modelsStorePath: join(root, "models-store.json"),
    refreshOnCreate: false,
  });
  await runtime.refresh({ allowNetwork: false });
  return runtime;
};
const provider = await create();
assert.deepEqual(provider.getModel("magpie", modelId)?.input, ["text"]);
const palette = [
  { name: "red", rgba: 0xff0000ff },
  { name: "blue", rgba: 0x0000ffff },
  { name: "green", rgba: 0x00aa00ff },
  { name: "yellow", rgba: 0xffff00ff },
];
for (let index = palette.length - 1; index > 0; index--) {
  const other = randomInt(index + 1);
  [palette[index], palette[other]] = [palette[other]!, palette[index]!];
}
const trials: unknown[] = [];
for (let trial = 0; trial < 2; trial++) {
  const left = palette[trial * 2]!;
  const right = palette[trial * 2 + 1]!;
  const canvas = new (createJimp({ formats: [png] }))({
    width: 1280,
    height: 800,
    color: 0xffffffff,
  });
  for (let y = 250; y < 550; y++) {
    for (let x = 150; x < 450; x++) canvas.setPixelColor(left.rgba, x, y);
    for (let x = 810; x < 1110; x++)
      if ((x - 960) ** 2 + (y - 400) ** 2 < 150 ** 2) canvas.setPixelColor(right.rgba, x, y);
  }
  const screenshot = await canvas.getBuffer("image/png");
  await writeFile(join(root, `screen-${trial}.png`), screenshot);
  let captures = 0;
  const runtime = new ComputerRuntime({
    actComputerUse: async () => {
      if (++captures > 3) throw new Error("Live test exceeded three screenshot calls");
      return screenshot;
    },
  } as never) as any;
  const tools = runtime.tools;
  tools.workspaceRoot = root;
  tools.privateBrowser = () => {
    throw new Error("Use the existing test screen");
  };
  runtime.agentDir = root;
  runtime.modelRuntime = provider;
  runtime.inferenceProviders = new InferenceProviderService(() => provider, modelsPath);
  runtime.compaction = new BotCompactionCoordinator(
    new BotCompactionArchiveStore(join(root, "archives")),
    0
  );
  const active: any = {
    contextSessionId: randomUUID(),
    botId: randomUUID(),
    screenBotId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    modelRef: { providerId: "magpie", modelId },
    reasoning: "off",
    cwd: root,
    instructions:
      "Take one screenshot with Computer, then answer the visual question briefly using what you see.",
    subagentType: "computerUse",
    requestSource: "subagent",
    userInfoMessage: null,
    pluginAbortController: new AbortController(),
    queue: { push() {} },
  };
  runtime.tools = {
    customTools: () => [
      {
        name: "Computer",
        label: "Computer",
        description: "Take a screenshot of the current test screen.",
        parameters: {
          type: "object",
          properties: { action: { type: "string", enum: ["screenshot"] } },
          required: ["action"],
        },
        execute: (id: string, args: unknown, signal: AbortSignal) =>
          tools.callComputerUse(active, args, signal),
      },
    ],
    acknowledgeToolOutcomes: async () => {},
  };
  const manager = SessionManager.create(root, join(root, "sessions"), {
    id: active.contextSessionId,
  });
  const session = await runtime.createStandaloneSession(
    root,
    active.instructions,
    manager,
    active,
    active.modelRef
  );
  active.session = session;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, timeoutMs);
  try {
    assert.deepEqual(provider.getModel("magpie", modelId)?.input, ["text", "image"]);
    await session.prompt(
      "First take a screenshot using Computer. What color is the square on the left, and what color is the circle on the right? Reply only LEFT=<color>; RIGHT=<color>."
    );
    clearTimeout(timeout);
    const messages = manager.buildSessionContext().messages as any[];
    const lastAssistant = messages.filter((message) => message.role === "assistant").at(-1);
    const answer =
      messages
        .filter((message) => message.role === "assistant")
        .at(-1)
        ?.content.filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n") ?? "";
    const images = messages
      .filter((message) => message.role === "toolResult")
      .flatMap((message) => message.content.filter((part: any) => part.type === "image"));
    const result = {
      trial,
      expected: { left: left.name, right: right.name },
      answer,
      captures,
      images: images.length,
      timedOut,
      stopReason: lastAssistant?.stopReason,
    };
    trials.push(result);
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({ modelId, advertised, trials, success: false }, null, 2)
    );
    console.log(JSON.stringify(result));
    assert.ok(!timedOut, "Live Magpie inference exceeded its deadline");
    assert.equal(lastAssistant?.stopReason, "stop", "The model must complete normally");
    assert.ok(
      captures > 0 && images.length > 0,
      "The real model must request and receive a screenshot"
    );
    assert.match(answer, new RegExp(`LEFT\\s*=\\s*${left.name}`, "i"));
    assert.match(answer, new RegExp(`RIGHT\\s*=\\s*${right.name}`, "i"));
  } finally {
    clearTimeout(timeout);
    session.dispose();
  }
}
const saved = JSON.parse(await readFile(modelsPath, "utf8"));
assert.deepEqual(saved.providers.magpie.models[0], { ...definition, input: ["text", "image"] });
assert.deepEqual((await create()).getModel("magpie", modelId)?.input, ["text", "image"]);
await writeFile(
  join(root, "result.json"),
  JSON.stringify({ modelId, advertised, trials, success: true }, null, 2)
);
console.log(
  "PASS: real Magpie screenshot inference, request-setting preservation, and restart persistence"
);
