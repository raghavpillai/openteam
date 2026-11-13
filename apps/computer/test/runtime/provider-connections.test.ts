import { expect, test } from "bun:test";
import { InMemoryCredentialStore, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { IdleProviderConnections, InferenceProviderConnections } from "../../src/runtime/provider-connections";
import { ComputerRuntime } from "../../src/runtime";
import type { ActiveTurn } from "../../src/runtime/types";
import { tempDirs } from "../temp";
const tempDir = tempDirs();

test("idle expiry releases resources, but never after the next turn acquires them", async () => {
  const released: string[] = [];
  const cache = new IdleProviderConnections(20, 2, (id) => {
    released.push(id);
  });
  cache.retain("active-again");
  cache.acquire("active-again");
  cache.retain("idle");
  await Bun.sleep(50);
  expect(released).toEqual(["idle"]);
  cache.retain("active-again");
  cache.close();
  expect(released).toEqual(["idle", "active-again"]);
});

test("capacity, deletion and shutdown bound retained resources", () => {
  const released: string[] = [];
  const cache = new IdleProviderConnections(60_000, 2, (id) => {
    released.push(id);
  });
  cache.retain("oldest");
  cache.retain("recent");
  cache.retain("newest");
  expect(released).toEqual(["oldest"]);
  cache.dispose("recent");
  cache.close();
  cache.retain("finishes-after-shutdown");
  expect(released).toEqual(["oldest", "recent", "newest", "finishes-after-shutdown"]);
});

test("actual Pi session disposal can retain transport while replacing all agent listeners", async () => {
  const directory = await tempDir("openteam-connection-");
  const releases: string[] = [];
  const unregister = registerSessionResourceCleanup((id) => {
    releases.push(id!);
  });
  const cache = new IdleProviderConnections();
  let first: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let second: typeof first;
  try {
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await resourceLoader.reload();
    const create = async () => (await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime, settingsManager, resourceLoader, noTools: "builtin", sessionManager: SessionManager.create(directory, directory),
    })).session;
    first = await create();
    let calls = 0;
    first.subscribe(() => {
      calls++;
    });
    first.dispose({ preserveProviderResources: true });
    (first as unknown as { _emit: (event: unknown) => void })._emit({ type: "agent_start" });
    expect(calls).toBe(0);
    expect(releases).not.toContain(first.sessionId);
    cache.retain(first.sessionId);
    cache.close();
    expect(releases.filter((id) => id === first!.sessionId)).toHaveLength(1);
    second = await create();
    second.dispose();
    expect(releases).toContain(second.sessionId);
  } finally {
    cache.close();
    first?.dispose();
    second?.dispose();
    unregister();
  }
});

test.each([
  [true, "openai-codex", true],
  [false, "openai-codex", false],
  [true, "anthropic", false],
] as const)("runtime cleanup: success=%s provider=%s retains=%s", async (success, providerId, expected) => {
  const runtime = new ComputerRuntime();
  const disposed: unknown[] = [];
  const retained: string[] = [];
  const internals = runtime as unknown as {
    cleanup: (active: ActiveTurn, preserve: boolean) => Promise<void>;
    providerConnections: { retain: (id: string) => void };
  };
  internals.providerConnections.retain = (id) => {
    retained.push(id);
  };
  const active = {
    runId: "cleanup-test",
    contextSessionId: "context",
    subagentType: "browser",
    modelRef: { providerId, modelId: "test" },
    pluginAbortController: new AbortController(),
    session: {
      sessionId: "context",
      dispose: (options: unknown) => {
        disposed.push(options);
      },
    },
  } as unknown as ActiveTurn;
  await internals.cleanup(active, success);
  expect(disposed).toEqual([{ preserveProviderResources: expected }]);
  expect(retained).toEqual(expected ? ["context"] : []);
  expect(active.session).toBeNull();
});

test("stateless transport leases reuse idle sockets without serializing a burst", () => {
  const released: string[] = [];
  const pool = new InferenceProviderConnections(2, 60_000, id => { released.push(id); });
  const first = pool.acquire("account-model-endpoint");
  const second = pool.acquire("account-model-endpoint");
  const overflow = pool.acquire("account-model-endpoint");
  expect(first.sessionId).toBeDefined();
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(overflow.sessionId).toBeUndefined();
  first.release(true);
  const reused = pool.acquire("account-model-endpoint");
  expect(reused.sessionId).toBe(first.sessionId);
  first.release(false); // A stale/double release must not close the new lease.
  expect(released).toEqual([]);
  reused.release(false);
  second.release(true);
  pool.close();
  expect(released).toEqual([first.sessionId!, second.sessionId!]);
});

test("model/endpoint changes, expiry and authentication reset isolate leases", async () => {
  const released: string[] = [];
  const pool = new InferenceProviderConnections(1, 15, id => { released.push(id); });
  const first = pool.acquire("model-a");
  first.release(true);
  const other = pool.acquire("model-b");
  expect(other.sessionId).not.toBe(first.sessionId);
  expect(released).toEqual([first.sessionId!]);
  await Bun.sleep(25); // Active sockets must not expire.
  expect(released).toHaveLength(1);
  other.release(true);
  await Bun.sleep(25);
  expect(released).toHaveLength(2);
  const active = pool.acquire("model-b");
  pool.clear();
  active.release(true); // Cannot reinsert resources after auth invalidation.
  const fresh = pool.acquire("model-b");
  expect(fresh.sessionId).not.toBe(active.sessionId);
  pool.close();
  fresh.release(true);
  expect(pool.acquire("model-b").sessionId).toBeUndefined();
});

test("real infer call retains full input and reasoning while discarding failed leases", async () => {
  const runtime = new ComputerRuntime();
  const state = runtime as any;
  const calls: any[] = [];
  const releases: string[] = [];
  state.inferenceConnections = new InferenceProviderConnections(2, 60_000, id => { releases.push(id); });
  state.start = async () => {};
  state.resolveModel = () => ({ api: "openai-codex-responses", id: "fixture", baseUrl: "https://fixture.invalid", reasoning: true, thinkingLevelMap: { off: "none" } });
  let fail = false;
  state.modelRuntime = {
    checkAuth: async () => ({ type: "oauth" }),
    streamSimple: (_model: unknown, context: unknown, options: unknown) => {
      calls.push({ context, options });
      const result = fail ? { stopReason: "error", errorMessage: "provider failed" }
        : { stopReason: "stop", content: [{ type: "text", text: "fixture result" }] };
      return { async *[Symbol.asyncIterator]() {}, result: async () => result };
    },
  };
  const request = { model: "openai-codex/fixture", reasoning: "off" as const, instructions: "unchanged instruction", prompt: "unchanged user input", cwd: "/tmp", timeoutMs: 1_000 };
  try {
    await runtime.infer(request);
    await runtime.infer(request);
    expect(calls[1].options.sessionId).toBe(calls[0].options.sessionId);
    expect(calls[1].options.transport).toBe("websocket");
    expect(calls[1].context.messages).toHaveLength(1);
    expect(calls[1].context.systemPrompt).toBe(request.instructions);
    expect(calls[1].context.messages[0].content[0].text).toBe(request.prompt);
    expect(calls[1].options.onPayload({}).reasoning.effort).toBe("none");
    fail = true;
    await expect(runtime.infer(request)).rejects.toThrow("provider failed");
    expect(releases).toEqual([calls[0].options.sessionId]);
    fail = false;
    await runtime.infer(request);
    expect(calls[3].options.sessionId).not.toBe(calls[0].options.sessionId);
  } finally { runtime.closeIdleProviderConnections(); }
});
