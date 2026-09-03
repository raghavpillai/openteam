import { describe, expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";

const inferenceRequest = {
  instructions: "Return the requested canary.",
  prompt: "Return OPENBOT_INFERENCE_OK.",
  cwd: "/workspace",
  timeoutMs: 5_000,
};

const runtimeWithResult = (result: unknown) => {
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as {
    start: () => Promise<void>;
    authenticated: boolean;
    modelRuntime: { completeSimple: () => Promise<unknown> };
    resolveModel: () => { reasoning: boolean };
  };
  internals.start = async () => undefined;
  internals.authenticated = true;
  internals.modelRuntime = { completeSimple: async () => result };
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
});
