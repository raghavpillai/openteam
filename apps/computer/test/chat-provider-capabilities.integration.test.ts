import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ChatProviderRegistry, KEYLESS_API_KEY } from "../src/chat-provider-registry";

const model = (id = "chat-a", input = ["text"]) => ({
  id,
  name: id,
  reasoning: false,
  input,
  contextWindow: 16000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const completion = (id: string) =>
  new Response(
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: id,
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );
async function fixture(
  options: {
    models?: Array<Record<string, unknown>>;
    input?: string[];
    nested?: boolean;
    requirements?: string;
    reasoningLevels?: string[];
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
  const path = join(root, "models.json");
  const state = {
    onList: async () => {},
    requests: [] as Array<{ route: string | null; body: any }>,
    input: options.input ?? ["text", "image"],
    reasoningLevels: options.reasoningLevels,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const endpoint = new URL(request.url).pathname;
      if (endpoint === "/v1/models") {
        await state.onList();
        return Response.json({
          data: ["chat-a", "chat-b"].map((id) => ({
            id,
            ...(state.reasoningLevels === undefined
              ? {}
              : {
                  supported_reasoning_levels: state.reasoningLevels,
                  default_reasoning_level: "high",
                }),
            ...(options.nested
              ? { modalities: { input: state.input } }
              : { input_modalities: state.input }),
          })),
        });
      }
      if (endpoint !== "/v1/chat/completions") return new Response(null, { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      const route = request.headers.get("x-model-route");
      state.requests.push({ route, body });
      const strict = options.requirements === "all";
      if (strict && route !== "model-deployment")
        return Response.json({ error: { message: "Missing route header" } }, { status: 403 });
      if (
        strict &&
        (!Object.hasOwn(body, "max_tokens") || Object.hasOwn(body, "max_completion_tokens"))
      )
        return Response.json({ error: { message: "Requires max_tokens" } }, { status: 400 });
      return completion(String(body.model));
    },
  });
  const config = {
    providers: {
      relay: {
        baseUrl: server.url.origin + "/v1",
        api: "openai-completions",
        apiKey: KEYLESS_API_KEY,
        models: options.models ?? [model(), model("chat-b")],
      },
    },
  };
  await writeFile(path, JSON.stringify(config));
  const create = async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: path,
      modelsStorePath: join(root, "models-store.json"),
      refreshOnCreate: false,
    });
    await runtime.refresh({ allowNetwork: false });
    return runtime;
  };
  const runtime = await create();
  const registry = new ChatProviderRegistry(() => runtime, path);
  const verify = (id = "chat-a") =>
    registry.verify({ providerId: "relay", modelId: id, reasoning: "off" });
  const infer = () =>
    runtime.completeSimple(
      runtime.getModel("relay", "chat-a")!,
      { messages: [{ role: "user", content: "Return ok", timestamp: Date.now() }] },
      { maxTokens: 8, signal: AbortSignal.timeout(3000) }
    );
  return {
    root,
    path,
    config,
    state,
    runtime,
    registry,
    verify,
    infer,
    create,
    read: async () => JSON.parse(await readFile(path, "utf8")),
    cleanup: async () => {
      server.stop(true);
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Upgrade with every request setting, downgrade with a dedicated base URL.
for (const [direction, kind] of [
  ["upgrade", "all"],
  ["downgrade", "baseUrl"],
] as const) {
  test(`${direction} preserves ${kind}, actual inference and restart`, async () => {
    let dedicatedCalls = 0;
    const dedicated = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        dedicatedCalls++;
        return completion("chat-a");
      },
    });
    const input: Array<"text" | "image"> = direction === "upgrade" ? ["text", "image"] : ["text"];
    const definition = {
      ...model("chat-a", direction === "upgrade" ? ["text"] : ["text", "image"]),
      ...(kind === "all"
        ? {
            headers: { "x-model-route": "model-deployment" },
            compat: { maxTokensField: "max_tokens", supportsStore: false },
            samplingParams: { temperature: 0.123, top_p: 0.45 },
          }
        : { baseUrl: dedicated.url.origin + "/dedicated" }),
    };
    const f = await fixture({
      models: [definition],
      input,
      requirements: kind,
      nested: direction === "upgrade",
    });
    try {
      expect((await f.infer()).stopReason).toBe("stop");
      await f.verify();
      expect((await f.infer()).stopReason).toBe("stop");
      expect(f.runtime.getModel("relay", "chat-a")?.input).toEqual(input);
      expect((await f.read()).providers.relay.models[0]).toEqual({ ...definition, input });
      expect((await f.create()).getModel("relay", "chat-a")?.input).toEqual(input);
      if (kind === "baseUrl") expect(dedicatedCalls).toBe(2);
      else expect(f.state.requests[1]?.body).toMatchObject({ temperature: 0.123, top_p: 0.45 });
      const inode = (await stat(f.path)).ino;
      await f.verify();
      expect((await stat(f.path)).ino).toBe(inode);
    } finally {
      dedicated.stop(true);
      await f.cleanup();
    }
  });
}

// A conflicting edit during discovery aborts without clobbering it, whether or not the
// advertised capabilities changed; an unrelated edit is merged.
for (const [change, input] of [
  ["credentials", ["text"]],
  ["invalid JSON", ["text"]],
  ["credentials", ["text", "image"]],
  ["remove model", ["text", "image"]],
  ["sibling", ["text"]],
] as const) {
  const unchanged = input.length === 2;
  test(`discovery respects an in-flight ${change} edit${unchanged ? " with unchanged capabilities" : ""}`, async () => {
    const f = await fixture({ models: [model("chat-a", [...input]), model("chat-b", [...input])] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.state.onList = async () => {
      entered.resolve();
      await release.promise;
    };
    try {
      const operation = f.verify().then(
        () => undefined,
        (error) => (error as Error).message
      );
      await entered.promise;
      const edited = structuredClone(f.config) as any;
      if (change === "credentials") edited.providers.relay.apiKey = "synthetic-private-replacement";
      if (change === "remove model") edited.providers.relay.models = [model("chat-b")];
      if (change === "sibling") edited.providers.relay.models[1].headers = { "x-sibling": "new" };
      const bytes = change === "invalid JSON" ? "{invalid-json" : JSON.stringify(edited);
      await writeFile(f.path, bytes);
      release.resolve();
      const error = await operation;
      if (change === "sibling") {
        expect(error).toBeUndefined();
        const saved = await f.read();
        expect(saved.providers.relay.models.find((m: any) => m.id === "chat-a").input).toEqual([
          "text",
          "image",
        ]);
        expect(saved.providers.relay.models.find((m: any) => m.id === "chat-b").headers).toEqual({
          "x-sibling": "new",
        });
      } else {
        expect(error).toMatch(/settings changed|Repair models.json/);
        expect(error).not.toContain("synthetic-private");
        expect(await readFile(f.path, "utf8")).toBe(bytes);
      }
    } finally {
      release.resolve();
      await f.cleanup();
    }
  }, 20000);
}

test("parallel verification of new models retains both across independent registries", async () => {
  for (let iteration = 0; iteration < 3; iteration++) {
    const f = await fixture({ models: [] });
    const ready = Promise.withResolvers<void>();
    let lists = 0;
    f.state.onList = async () => {
      if (++lists === 2) ready.resolve();
      await ready.promise;
    };
    try {
      const other = new ChatProviderRegistry(() => f.runtime, f.path);
      await Promise.all([
        f.verify(),
        other.verify({ providerId: "relay", modelId: "chat-b", reasoning: "off" }),
      ]);
      const saved = (await f.read()).providers.relay.models;
      expect(saved.map((m: any) => m.id).sort()).toEqual(["chat-a", "chat-b"]);
      for (const value of saved) expect(value.input).toEqual(["text", "image"]);
    } finally {
      ready.resolve();
      await f.cleanup();
    }
  }
}, 20000);

const runCli = async (root: string, args: string[], input?: unknown) => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/provider-cli.ts"), ...args], {
    env: { PATH: process.env.PATH!, PI_OFFLINE: "1", OPENTEAM_PI_AGENT_DIR: root },
    stdin: input ? new Blob([JSON.stringify(input)]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
};

test("independent CLI processes verify and add providers without overwriting one another", async () => {
  const f = await fixture();
  const custom = (id: string, name = id) => ({
    id,
    name,
    baseUrl: f.config.providers.relay.baseUrl,
    api: "openai-completions",
    noAuth: true,
    createOnly: true,
  });
  try {
    const results = await Promise.all([
      runCli(f.root, ["verify", "relay", "chat-a", "off"]),
      runCli(f.root, ["verify", "relay", "chat-b", "off"]),
      runCli(f.root, ["add-custom"], custom("one")),
      runCli(f.root, ["add-custom"], custom("two")),
      runCli(f.root, ["add-custom"], custom("new-relay", "first")),
      runCli(f.root, ["add-custom"], custom("new-relay", "second")),
    ]);
    expect(results.slice(0, 4)).toEqual(results.slice(0, 4).map(() => ({ code: 0, stderr: "" })));
    // Create-only requests for the same ID: exactly one wins and neither replaces the other.
    const racing = results.slice(4);
    expect(racing.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(racing.find((result) => result.code === 1)?.stderr).toContain("already exists");
    const saved = await f.read();
    expect(Object.keys(saved.providers).sort()).toEqual(["new-relay", "one", "relay", "two"]);
    expect(saved.providers["new-relay"].name).toBe(racing[0]!.code === 0 ? "first" : "second");
    for (const value of saved.providers.relay.models)
      expect(value.input).toEqual(["text", "image"]);
  } finally {
    await f.cleanup();
  }
}, 20000);

test("a failed capability write keeps the original file and runtime metadata", async () => {
  const f = await fixture();
  const before = await readFile(f.path, "utf8");
  try {
    await chmod(f.root, 0o500);
    await expect(f.verify()).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(f.runtime.getModel("relay", "chat-a")?.input).toEqual(["text"]);
  } finally {
    await f.cleanup();
  }
});

test("unchanged verification reloads a concurrent selected-model edit without needing a writable directory", async () => {
  const f = await fixture({ models: [model()], input: ["text"] });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.onList = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const operation = f.verify();
    await entered.promise;
    const edited = structuredClone(f.config) as any;
    edited.providers.relay.models[0].samplingParams = { temperature: 0.75 };
    await writeFile(f.path, JSON.stringify(edited));
    await chmod(f.root, 0o500);
    release.resolve();
    await operation;
    expect(f.runtime.getModel("relay", "chat-a")?.samplingParams).toEqual({ temperature: 0.75 });
    expect(await f.read()).toEqual(edited);
  } finally {
    release.resolve();
    await f.cleanup();
  }
});

test("CLI removal during unchanged discovery cannot be undone", async () => {
  const f = await fixture({ models: [model("chat-a", ["text"])], input: ["text"] });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.onList = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const operation = f.verify().then(
      () => undefined,
      (error) => (error as Error).message
    );
    await entered.promise;
    expect(await runCli(f.root, ["remove-custom", "relay"])).toEqual({ code: 0, stderr: "" });
    release.resolve();
    expect(await operation).toMatch(/Provider settings changed/);
    expect((await f.read()).providers.relay).toBeUndefined();
    expect((await f.create()).getModel("relay", "chat-a")).toBeUndefined();
  } finally {
    release.resolve();
    await f.cleanup();
  }
}, 15000);

test("custom reasoning repair preserves request settings and serialized inference after restart", async () => {
  const definition = {
    ...model("chat-a", ["text", "image"]),
    reasoning: true,
    thinkingLevelMap: { off: "none", high: "stale-high" },
    headers: { "x-model-route": "model-deployment" },
    compat: { maxTokensField: "max_tokens", supportsStore: false },
    samplingParams: { temperature: 0.25 },
  };
  const f = await fixture({
    models: [definition],
    input: ["text", "image"],
    reasoningLevels: ["none", "high"],
    requirements: "all",
  });
  try {
    await f.registry.verify({ providerId: "relay", modelId: "chat-a", reasoning: "high" });
    // Re-verifying unchanged reasoning metadata must not rewrite the file.
    const inode = (await stat(f.path)).ino;
    await f.registry.verify({ providerId: "relay", modelId: "chat-a", reasoning: "high" });
    expect((await stat(f.path)).ino).toBe(inode);
    const saved = (await f.read()).providers.relay.models[0];
    expect(saved).toEqual({
      ...definition,
      reasoningLevels: ["off", "high"],
      defaultReasoningLevel: "high",
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
    });
    const restarted = await f.create();
    const restored = restarted.getModel("relay", "chat-a")!;
    const { reasoningCapabilities } = await import("../src/reasoning-capabilities");
    const { inferenceReasoningOptions } = await import("../src/runtime/reasoning");
    expect(reasoningCapabilities(restored).reasoningLevels).toEqual(["off", "high"]);
    const response = await restarted.completeSimple(
      restored,
      { messages: [{ role: "user", content: "reasoning check", timestamp: 0 }] },
      { ...inferenceReasoningOptions(restored, "high"), maxTokens: 8, maxRetries: 0 }
    );
    expect(response.stopReason).toBe("stop");
    expect(f.state.requests.at(-1)?.body.reasoning_effort).toBe("high");
    expect(f.state.requests.at(-1)?.route).toBe("model-deployment");
    f.state.reasoningLevels = [];
    await f.verify();
    const cleared = (await f.read()).providers.relay.models[0];
    expect(cleared).toMatchObject({
      reasoning: false,
      reasoningLevels: ["off"],
      defaultReasoningLevel: "off",
      headers: definition.headers,
      compat: definition.compat,
      samplingParams: definition.samplingParams,
    });
    expect(Object.values(cleared.thinkingLevelMap)).toEqual(Array(7).fill(null));
    expect(
      reasoningCapabilities((await f.create()).getModel("relay", "chat-a")!).reasoningLevels
    ).toEqual(["off"]);
  } finally {
    await f.cleanup();
  }
});
