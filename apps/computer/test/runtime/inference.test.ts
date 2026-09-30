import { describe, expect, test, spyOn } from "bun:test";
import { ComputerRuntime } from "../../src/runtime";

const inferenceRequest = {
  instructions: "Return the requested canary.",
  prompt: "Return OPENTEAM_INFERENCE_OK.",
  cwd: "/workspace",
  timeoutMs: 5_000,
  model: "openai-codex/gpt-5.5",
  reasoning: "high" as const,
};

const runtimeWithResult = (result: unknown) => {
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as {
    start: () => Promise<void>;
    authenticated: boolean;
    modelRuntime: {
      checkAuth: () => Promise<{ type: "api_key" }>;
      completeSimple: (...args: any[]) => Promise<unknown>;
      streamSimple: (...args: any[]) => unknown;
    };
    resolveModel: () => { reasoning: boolean };
  };
  internals.start = async () => undefined;
  internals.authenticated = true;
  internals.modelRuntime = {
    checkAuth: async () => ({ type: "api_key" }),
    completeSimple: async () => result,
    streamSimple: (...args: any[]) => {
      const completion = internals.modelRuntime.completeSimple(...args);
      return {
        async *[Symbol.asyncIterator]() { await completion; },
        result: () => completion,
      };
    },
  };
  internals.resolveModel = () => ({ reasoning: true });
  return runtime;
};

describe("memory inference", () => {
  test("stream timing excludes empty/start events and preserves pre-timeout progress", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
    try {
      for (const withText of [false, true]) {
        const runtime = runtimeWithResult(null);
        (runtime as any).modelRuntime.streamSimple = (_model: unknown, _context: unknown, options: any) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "start" };
            yield { type: "text_delta", delta: "" };
            if (withText) {
              yield { type: "thinking_delta", delta: "PRIVATE_REASONING" };
              await Bun.sleep(5);
              yield { type: "text_delta", delta: "PRIVATE_RESPONSE" };
            }
            await new Promise((_, reject) => options.signal.addEventListener("abort",
              () => reject(new Error("PRIVATE_ERROR")), { once: true }));
          },
          result: () => { throw new Error("No final result on interrupted stream"); },
        });
        await expect(runtime.infer({ ...inferenceRequest, timeoutMs: 30 })).rejects.toThrow("timed out");
        const metrics = JSON.parse(logs.at(-1)!);
        expect(metrics.outcome).toBe("timeout");
        if (withText) {
          expect(metrics.firstDeltaMs).toBeGreaterThanOrEqual(0);
          expect(metrics.firstTextDeltaMs).toBeGreaterThanOrEqual(metrics.firstDeltaMs);
        } else {
          expect(metrics.firstDeltaMs).toBeNull();
          expect(metrics.firstTextDeltaMs).toBeNull();
        }
      }
      expect(logs.join("\n")).not.toContain("PRIVATE_");
    } finally { spy.mockRestore(); }
  });

  test("visual review sends the observation as an image without changing text or tool access", async () => {
    const runtime = runtimeWithResult(null);
    const image = { type: "image" as const, mimeType: "image/png", data: "SYNTHETIC_IMAGE_BYTES" };
    const internals = runtime as any;
    internals.resolveModel = () => ({ reasoning: true, input: ["text", "image"] });
    internals.modelRuntime.completeSimple = async (_model: unknown, context: any) => {
      expect(context.systemPrompt).toBe(inferenceRequest.instructions);
      expect(context.tools).toEqual([]);
      expect(context.messages[0].content).toEqual([{ type: "text", text: inferenceRequest.prompt }, image]);
      return { stopReason: "stop", content: [{ type: "text", text: "decision" }] };
    };
    await expect(runtime.infer({ ...inferenceRequest, images: [image] })).resolves.toBe("decision");
    internals.resolveModel = () => ({ reasoning: true, input: ["text"] });
    await expect(runtime.infer({ ...inferenceRequest, images: [image] })).rejects.toThrow("cannot review visual evidence");
  });
  test("utility metrics expose usage and outcome without request or response content", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
    try {
      const runtime = runtimeWithResult({
        stopReason: "stop",
        content: [{ type: "text", text: "PRIVATE_RESPONSE" }],
        usage: { input: 120, cacheRead: 80, output: 12, reasoning: 5 },
      });
      await expect(runtime.infer({ ...inferenceRequest, kind: "verification",
        instructions: "PRIVATE_INSTRUCTIONS", prompt: "PRIVATE_PROMPT", cwd: "/PRIVATE_PATH",
      })).resolves.toBe("PRIVATE_RESPONSE");
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        event: "utility_inference.metrics", kind: "verification", outcome: "success",
        provider: "openai-codex", model: "gpt-5.5", reasoning: "high",
        inputTokens: 120, cachedInputTokens: 80, outputTokens: 12, reasoningTokens: 5,
      });
      expect(JSON.parse(logs[0]!).durationMs).toBeGreaterThanOrEqual(0);
      expect(logs.join("\n")).not.toContain("PRIVATE_");
      const failing = runtimeWithResult({ stopReason: "error", errorMessage: "PRIVATE_ERROR", content: [] });
      await expect(failing.infer(inferenceRequest)).rejects.toThrow("PRIVATE_ERROR");
      expect(JSON.parse(logs[1]!)).toMatchObject({ outcome: "error", kind: "unspecified" });
      expect(logs.join("\n")).not.toContain("PRIVATE_");
    } finally { spy.mockRestore(); }
  });
  test("caller cancellation cancels the underlying provider completion", async () => {
    const runtime = runtimeWithResult(null);
    const controller = new AbortController();
    let providerCanceled = false;
    const internals = runtime as unknown as {
      modelRuntime: { completeSimple: (...arguments_: unknown[]) => Promise<unknown> };
    };
    internals.modelRuntime.completeSimple = async (_model, _context, options) => {
      const { signal } = options as { signal: AbortSignal };
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            providerCanceled = true;
            reject(new Error("Provider canceled"));
          },
          { once: true }
        );
        controller.abort();
      });
    };
    await expect(runtime.infer({ ...inferenceRequest, signal: controller.signal })).rejects.toThrow(
      "Memory inference canceled"
    );
    expect(providerCanceled).toBe(true);
  });

  test("an actual HTTP disconnect reaches the provider through the request signal", async () => {
    const runtime = runtimeWithResult(null);
    const controller = new AbortController();
    let entered!: () => void;
    let canceled!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const providerCanceled = new Promise<void>((resolve) => {
      canceled = resolve;
    });
    const internals = runtime as unknown as {
      modelRuntime: { completeSimple: (...arguments_: unknown[]) => Promise<unknown> };
    };
    internals.modelRuntime.completeSimple = async (_model, _context, options) => {
      const { signal } = options as { signal: AbortSignal };
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            canceled();
            reject(new Error("Provider canceled"));
          },
          { once: true }
        );
        entered();
      });
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        try {
          return new Response(await runtime.infer({ ...inferenceRequest, signal: request.signal }));
        } catch {
          return new Response("Canceled", { status: 499 });
        }
      },
    });
    try {
      const request = fetch(`http://127.0.0.1:${server.port}/`, {
        signal: controller.signal,
      }).catch((error) => error);
      await providerEntered;
      controller.abort();
      await providerCanceled;
      expect(await request).toBeInstanceOf(Error);
    } finally {
      controller.abort();
      await server.stop(true);
    }
  });

  test("an already canceled request never starts inference", async () => {
    const runtime = runtimeWithResult(null);
    const controller = new AbortController();
    controller.abort();
    const internals = runtime as unknown as { start: () => Promise<void> };
    internals.start = async () => {
      throw new Error("must not start a canceled request");
    };
    await expect(runtime.infer({ ...inferenceRequest, signal: controller.signal })).rejects.toThrow(
      "Memory inference canceled"
    );
  });

  test("an inference deadline cancels the provider and preserves the timeout error", async () => {
    const runtime = runtimeWithResult(null);
    let providerCanceled = false;
    const internals = runtime as unknown as {
      modelRuntime: { completeSimple: (...arguments_: unknown[]) => Promise<unknown> };
    };
    internals.modelRuntime.completeSimple = async (_model, _context, options) => {
      const { signal } = options as { signal: AbortSignal };
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            providerCanceled = true;
            reject(new Error("Provider deadline"));
          },
          { once: true }
        )
      );
    };
    await expect(runtime.infer({ ...inferenceRequest, timeoutMs: 5 })).rejects.toThrow(
      "Memory inference timed out"
    );
    expect(providerCanceled).toBe(true);
  });

  test("returns assistant text from a successful direct Pi completion", async () => {
    const runtime = runtimeWithResult({
      stopReason: "stop",
      content: [{ type: "text", text: "OPENTEAM_INFERENCE_OK" }],
    });

    await expect(runtime.infer(inferenceRequest)).resolves.toBe("OPENTEAM_INFERENCE_OK");
  });

  test("preserves the provider error when Pi returns an error completion", async () => {
    const runtime = runtimeWithResult({
      stopReason: "error",
      errorMessage: "Provider endpoint could not be reached",
      content: [],
    });

    await expect(runtime.infer(inferenceRequest)).rejects.toThrow(
      "Provider endpoint could not be reached"
    );
  });

  test("uses the provider-qualified model and reasoning supplied at runtime", async () => {
    const runtime = runtimeWithResult({
      stopReason: "stop",
      content: [{ type: "text", text: "dynamic" }],
    });
    let resolved: unknown;
    let completionOptions: unknown;
    const internals = runtime as unknown as {
      resolveModel: (reference: unknown) => { reasoning: boolean };
      modelRuntime: {
        checkAuth: () => Promise<{ type: "api_key" }>;
        completeSimple: (...arguments_: unknown[]) => Promise<unknown>;
      };
    };
    internals.resolveModel = (reference) => {
      resolved = reference;
      return { reasoning: true };
    };
    internals.modelRuntime.completeSimple = async (...arguments_) => {
      completionOptions = arguments_[2];
      return { stopReason: "stop", content: [{ type: "text", text: "dynamic" }] };
    };

    await runtime.infer({
      ...inferenceRequest,
      model: "anthropic/claude-test",
      reasoning: "low",
    });

    expect(resolved).toEqual({ providerId: "anthropic", modelId: "claude-test" });
    expect(completionOptions).toMatchObject({ reasoning: "low" });
  });

  test("does not infer a provider for an unqualified runtime model", async () => {
    const runtime = runtimeWithResult({
      stopReason: "stop",
      content: [{ type: "text", text: "unused" }],
    });
    await expect(runtime.infer({ ...inferenceRequest, model: "gpt-5.5" })).rejects.toThrow(
      "provider-qualified"
    );
  });
});
