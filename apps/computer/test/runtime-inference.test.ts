import { describe, expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";

const inferenceRequest = {
  instructions: "Return the requested canary.",
  prompt: "Return OPENBOT_INFERENCE_OK.",
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
  test("returns assistant text from a successful direct Pi completion", async () => {
    const runtime = runtimeWithResult({
      stopReason: "stop",
      content: [{ type: "text", text: "OPENBOT_INFERENCE_OK" }],
    });

    await expect(runtime.infer(inferenceRequest)).resolves.toBe("OPENBOT_INFERENCE_OK");
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
