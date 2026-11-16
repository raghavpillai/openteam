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
  const internals = runtime as any;
  internals.start = async () => undefined;
  internals.authenticated = true;
  internals.modelRuntime = {
    checkAuth: async () => ({ type: "api_key" }),
    completeSimple: async () => result,
    streamSimple: (...args: any[]) => {
      const completion = internals.modelRuntime.completeSimple(...args);
      return { async *[Symbol.asyncIterator]() { await completion; }, result: () => completion };
    },
  };
  internals.resolveModel = () => ({ reasoning: true });
  return runtime;
};

describe("memory inference", () => {

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

  /** A provider call that only settles when its request signal aborts. */
  const hangingProvider = (runtime: ComputerRuntime, onCall: () => void, onAbort: () => void) => {
    (runtime as any).modelRuntime.completeSimple = async (_model: unknown, _context: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => { onAbort(); reject(new Error("Provider canceled")); }, { once: true });
        onCall();
      });
  };

  test("a caller abort or the inference deadline cancels the provider, preserving the timeout error", async () => {
    const runtime = runtimeWithResult(null);
    let canceled = 0, entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => (entered = resolve));
    hangingProvider(runtime, () => entered(), () => canceled++);
    const controller = new AbortController();
    const outcome = runtime.infer({ ...inferenceRequest, signal: controller.signal }).catch((error) => error);
    await providerEntered;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await expect(runtime.infer({ ...inferenceRequest, timeoutMs: 5 })).rejects.toThrow("Memory inference timed out");
    expect(canceled).toBe(2);
  });

  test("uses the provider-qualified model and reasoning supplied at runtime, and never guesses a provider", async () => {
    const runtime = runtimeWithResult(null);
    const internals = runtime as any;
    let resolved: unknown;
    let completionOptions: unknown;
    internals.resolveModel = (reference: unknown) => {
      resolved = reference;
      return { reasoning: true };
    };
    internals.modelRuntime.completeSimple = async (...args: unknown[]) => {
      completionOptions = args[2];
      return { stopReason: "stop", content: [{ type: "text", text: "dynamic" }] };
    };
    await runtime.infer({ ...inferenceRequest, model: "anthropic/claude-test", reasoning: "low" });
    expect(resolved).toEqual({ providerId: "anthropic", modelId: "claude-test" });
    expect(completionOptions).toMatchObject({ reasoning: "low" });
    await expect(runtime.infer({ ...inferenceRequest, model: "gpt-5.5" })).rejects.toThrow("provider-qualified");
  });
});
