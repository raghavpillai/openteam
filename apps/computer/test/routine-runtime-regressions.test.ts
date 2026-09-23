import { expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";
import { RuntimeTools } from "../src/runtime/tools";
import { NativeToolExecutor } from "../src/native-tool-executor";

test("run cancellation releases approval and shell waits before waiting for the session to abort", async () => {
  const order: string[] = [];
  const runtime = Object.create(ComputerRuntime.prototype) as any;
  runtime.activeByRun = new Map([
    [
      "owned",
      {
        session: {
          abort: async () => {
            expect(order).toEqual(["approval", "shell"]);
            order.push("session");
          },
        },
      },
    ],
  ]);
  runtime.tools = {
    cancelApprovals: (id: string) => {
      expect(id).toBe("owned");
      order.push("approval");
    },
    interruptShellWaits: (id: string) => {
      expect(id).toBe("owned");
      order.push("shell");
    },
  };
  await runtime.cancel("owned");
  expect(order).toEqual(["approval", "shell", "session"]);
});

test("approval cleanup rejects only the ended run and leaves other routines alone", () => {
  const settled: string[] = [];
  const runtimeTools = Object.create(RuntimeTools.prototype) as any;
  runtimeTools.pendingApprovals = new Map(
    ["ended", "other"].map((runId) => [
      runId,
      {
        runId,
        settle: (decision: unknown, error: Error) => {
          expect(decision).toBeUndefined();
          expect(error.message).toContain("run ended");
          settled.push(runId);
          runtimeTools.pendingApprovals.delete(runId);
        },
      },
    ])
  );
  runtimeTools.cancelApprovals("ended");
  expect(settled).toEqual(["ended"]);
  expect(runtimeTools.pendingApprovals.has("other")).toBe(true);
});

test("Task review receives actual combined-worker capabilities without granting extra authorization", async () => {
  const requests: any[] = [];
  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({ allowed: true });
    },
  });
  try {
    const executor = new NativeToolExecutor({
      agentDir: "/tmp",
      controlToken: "fixture",
      hostBridgeUrl: bridge.url.origin,
    });
    for (const combinedComputerUse of [true, false])
      await executor.autoReviewTask(
        {
          prompt: "Use browser tools only.",
          description: "Routine browser check",
          subagent_type: "computerUse",
        },
        undefined,
        undefined,
        { combinedComputerUse }
      );
    expect(requests[0].arguments.runtimeCapabilities.tools).toEqual(["browser_*", "Computer"]);
    expect(requests[1].arguments.runtimeCapabilities.tools).toEqual(["Computer"]);
    expect(requests[0].arguments.runtimeCapabilities.guidance).toContain(
      "not additional authorization"
    );
    expect(
      requests.every((request) => request.arguments.prompt === "Use browser tools only.")
    ).toBe(true);
  } finally {
    bridge.stop(true);
  }
});
