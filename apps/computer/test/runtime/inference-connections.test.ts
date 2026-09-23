import { expect, test } from "bun:test";
import { InferenceProviderConnections } from "../../src/runtime/provider-connections";
import { ComputerRuntime } from "../../src/runtime";

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
  state.resolveModel = () => ({ api: "openai-codex-responses", id: "fixture", baseUrl: "https://fixture.invalid", reasoning: true });
  let fail = false;
  state.modelRuntime = {
    checkAuth: async () => ({ type: "oauth" }),
    completeSimple: async (_model: unknown, context: unknown, options: unknown) => {
      calls.push({ context, options });
      return fail ? { stopReason: "error", errorMessage: "provider failed" }
        : { stopReason: "stop", content: [{ type: "text", text: "fixture result" }] };
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
