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
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
  const path = join(root, "models.json");
  const state = {
    onList: async () => {},
    requests: [] as Array<{ route: string | null; body: any }>,
    input: options.input ?? ["text", "image"],
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
      const kind = options.requirements;
      if ((kind === "headers" || kind === "all") && route !== "model-deployment")
        return Response.json({ error: { message: "Missing route header" } }, { status: 403 });
      if (
        (kind === "compat" || kind === "all") &&
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

for (const direction of ["upgrade", "downgrade"] as const) {
  for (const kind of ["headers", "compat", "sampling", "baseUrl", "all"]) {
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
        ...(kind === "headers" || kind === "all"
          ? { headers: { "x-model-route": "model-deployment" } }
          : {}),
        ...(kind === "compat" || kind === "all"
          ? { compat: { maxTokensField: "max_tokens", supportsStore: false } }
          : {}),
        ...(kind === "sampling" || kind === "all"
          ? { samplingParams: { temperature: 0.123, top_p: 0.45 } }
          : {}),
        ...(kind === "baseUrl" ? { baseUrl: dedicated.url.origin + "/dedicated" } : {}),
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
        if (kind === "sampling" || kind === "all") {
          expect(f.state.requests[1]?.body.temperature).toBe(0.123);
          expect(f.state.requests[1]?.body.top_p).toBe(0.45);
        }
        const inode = (await stat(f.path)).ino;
        await f.verify();
        expect((await stat(f.path)).ino).toBe(inode);
      } finally {
        dedicated.stop(true);
        await f.cleanup();
      }
    });
  }
}

for (const change of [
  "remove provider",
  "API",
  "URL",
  "credentials",
  "headers",
  "remove model",
  "sibling",
  "selected model",
  "invalid JSON",
] as const) {
  test(`discovery respects an in-flight ${change} edit`, async () => {
    const f = await fixture();
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
      if (change === "remove provider") delete edited.providers.relay;
      if (change === "API") edited.providers.relay.api = "anthropic-messages";
      if (change === "URL") edited.providers.relay.baseUrl = "http://127.0.0.1:1/replacement";
      if (change === "credentials") edited.providers.relay.apiKey = "synthetic-private-replacement";
      if (change === "headers") edited.providers.relay.headers = { "x-replacement": "new" };
      if (change === "remove model") edited.providers.relay.models = [model("chat-b")];
      if (change === "sibling") edited.providers.relay.models[1].headers = { "x-sibling": "new" };
      if (change === "selected model")
        edited.providers.relay.models[0].samplingParams = { temperature: 0.25 };
      const bytes = change === "invalid JSON" ? "{invalid-json" : JSON.stringify(edited);
      await writeFile(f.path, bytes);
      release.resolve();
      const error = await operation;
      if (change === "sibling" || change === "selected model") {
        expect(error).toBeUndefined();
        const saved = await f.read();
        expect(saved.providers.relay.models.find((m: any) => m.id === "chat-a").input).toEqual([
          "text",
          "image",
        ]);
        if (change === "sibling")
          expect(saved.providers.relay.models.find((m: any) => m.id === "chat-b").headers).toEqual({
            "x-sibling": "new",
          });
        else
          expect(
            saved.providers.relay.models.find((m: any) => m.id === "chat-a").samplingParams
          ).toEqual({ temperature: 0.25 });
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

for (const initial of ["new", "saved"] as const) {
  test(`parallel verification retains both ${initial} models across independent registries`, async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const f = await fixture({ models: initial === "new" ? [] : [model(), model("chat-b")] });
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
}

test("independent CLI processes can verify and add providers without overwriting one another", async () => {
  const f = await fixture();
  const cli = resolve(import.meta.dir, "../src/provider-cli.ts");
  const run = async (args: string[], input?: unknown) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      env: { PATH: process.env.PATH!, PI_OFFLINE: "1", OPENTEAM_PI_AGENT_DIR: f.root },
      stdin: input ? new Blob([JSON.stringify(input)]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const results = await Promise.all([
      run(["verify", "relay", "chat-a", "off"]),
      run(["verify", "relay", "chat-b", "off"]),
      ...["one", "two", "three"].map((id) =>
        run(["add-custom"], {
          id,
          name: id,
          baseUrl: f.config.providers.relay.baseUrl,
          api: "openai-completions",
          noAuth: true,
          createOnly: true,
        })
      ),
    ]);
    expect(results.map((result) => ({ code: result.code, error: result.stderr }))).toEqual(
      results.map(() => ({ code: 0, error: "" }))
    );
    const saved = await f.read();
    expect(Object.keys(saved.providers).sort()).toEqual(["one", "relay", "three", "two"]);
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

for (const input of [["text"], ["text", "image"]]) {
  for (const change of [
    "remove provider",
    "API",
    "URL",
    "credentials",
    "headers",
    "remove model",
    "invalid JSON",
  ] as const) {
    test(`unchanged ${input.join("+")} capabilities still reject an in-flight ${change} edit`, async () => {
      const f = await fixture({ models: [model("chat-a", input)], input });
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
        if (change === "remove provider") delete edited.providers.relay;
        if (change === "API") edited.providers.relay.api = "anthropic-messages";
        if (change === "URL") edited.providers.relay.baseUrl = "http://127.0.0.1:1/replacement";
        if (change === "credentials")
          edited.providers.relay.apiKey = "synthetic-private-replacement";
        if (change === "headers") edited.providers.relay.headers = { "x-replacement": "new" };
        if (change === "remove model") edited.providers.relay.models = [];
        const bytes = change === "invalid JSON" ? "{invalid-json" : JSON.stringify(edited);
        await writeFile(f.path, bytes);
        release.resolve();
        const error = await operation;
        expect(error).toMatch(/settings changed|Repair models.json/);
        expect(error).not.toContain("synthetic-private");
        expect(await readFile(f.path, "utf8")).toBe(bytes);
      } finally {
        release.resolve();
        await f.cleanup();
      }
    });
  }
}

test("same-model verification contention remains idempotent and preserves request settings", async () => {
  const definition = {
    ...model(),
    headers: { "x-preserve": "value" },
    compat: { maxTokensField: "max_tokens" },
    samplingParams: { temperature: 0.25 },
  };
  const f = await fixture({ models: [definition] });
  try {
    await Promise.all(
      Array.from({ length: 16 }, () =>
        new ChatProviderRegistry(() => f.runtime, f.path).verify({
          providerId: "relay",
          modelId: "chat-a",
          reasoning: "off",
        })
      )
    );
    expect((await f.read()).providers.relay.models).toEqual([
      { ...definition, input: ["text", "image"] },
    ]);
    expect(f.runtime.getModel("relay", "chat-a")?.input).toEqual(["text", "image"]);
  } finally {
    await f.cleanup();
  }
}, 15000);

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

for (const input of [["text"], ["text", "image"]]) {
  test(`CLI removal during unchanged ${input.join("+")} discovery cannot be undone`, async () => {
    const f = await fixture({ models: [model("chat-a", input)], input });
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
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../src/provider-cli.ts"),
          "remove-custom",
          "relay",
        ],
        {
          env: { PATH: process.env.PATH!, PI_OFFLINE: "1", OPENTEAM_PI_AGENT_DIR: f.root },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      release.resolve();
      expect(await operation).toMatch(/Provider settings changed/);
      expect((await f.read()).providers.relay).toBeUndefined();
      expect((await f.create()).getModel("relay", "chat-a")).toBeUndefined();
    } finally {
      release.resolve();
      await f.cleanup();
    }
  }, 15000);
}

test("simultaneous create-only CLI requests cannot replace each other's provider", async () => {
  const f = await fixture();
  try {
    const cli = resolve(import.meta.dir, "../src/provider-cli.ts");
    const results = await Promise.all(
      ["first", "second"].map(async (name) => {
        const child = Bun.spawn([process.execPath, cli, "add-custom"], {
          env: { PATH: process.env.PATH!, PI_OFFLINE: "1", OPENTEAM_PI_AGENT_DIR: f.root },
          stdin: new Blob([
            JSON.stringify({
              id: "new-relay",
              name,
              api: "openai-completions",
              baseUrl: f.config.providers.relay.baseUrl,
              noAuth: true,
              createOnly: true,
            }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { name, code, stdout, stderr };
      })
    );
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(results.find((result) => result.code === 1)?.stderr).toContain("already exists");
    expect((await f.read()).providers["new-relay"].name).toBe(
      results.find((result) => result.code === 0)?.name
    );
    expect((await f.read()).providers.relay).toEqual(f.config.providers.relay);
  } finally {
    await f.cleanup();
  }
}, 15000);
