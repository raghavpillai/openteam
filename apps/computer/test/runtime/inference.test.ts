import { describe, expect, test } from "bun:test";
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
      completeSimple: () => Promise<unknown>;
    };
    resolveModel: () => { reasoning: boolean };
  };
  internals.start = async () => undefined;
  internals.authenticated = true;
  internals.modelRuntime = {
    checkAuth: async () => ({ type: "api_key" }),
    completeSimple: async () => result,
  };
  internals.resolveModel = () => ({ reasoning: true });
  return runtime;
};

describe("memory inference", () => {
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
