import { expect, test } from "bun:test";
import { includeSubagentFailures } from "../src/subagent-result";
import { WakeWorker } from "../src/worker";

test("clean completion keeps the worker report unchanged", () => {
  expect(includeSubagentFailures("Done.", [])).toBe("Done.");
});

test("failure evidence excludes command arguments and binary payloads and bounds text", () => {
  const result = includeSubagentFailures("Recovered.", [{ kind: "command", content: {
    command: "SECRET_COMMAND", result: { content: [
      { type: "image", data: "SECRET_IMAGE" }, { type: "text", text: "Blocked: " + "x".repeat(5000) },
    ] },
  } }]);
  expect(result).toContain('"tool":"Shell"');
  expect(result).toContain("Blocked:");
  expect(result).not.toContain("SECRET_");
  expect(result.length).toBeLessThan(1000);
});

test("completion persists and delivers observed failures despite a misleading worker report", async () => {
  const writes: any[] = [];
  let delivered: string | undefined;
  let query: any;
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async (...args: any[]) => { delivered = args[3]; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", status: "running" }), update: async (arg: any) => writes.push(arg) },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { writes.push(arg); return { runInBackground: true }; } },
    message: { findFirst: async () => ({ content: "Done. Nothing failed." }) },
    runItem: { findMany: async (arg: any) => {
      query = arg;
      return [{ kind: "tool", content: { tool: "browser_click", result: { content: [{ type: "text", text: "Target detached" }] } } }];
    } },
    event: { create: async () => {} },
  };
  await worker.completeSubagent(tx, { botId: "bot", runId: "child-run" });
  expect(query.where).toEqual({ runId: "child-run", kind: { in: ["tool", "command"] },
    OR: [
      { status: "failed" },
      { content: { path: ["result", "isError"], equals: true } },
      { kind: "command", content: { path: ["result", "details", "exitCode"], gt: 0 } },
      { kind: "command", content: { path: ["result", "details", "exitCode"], lt: 0 } },
    ],
  });
  expect(query.take).toBe(20);
  expect(writes).toHaveLength(2);
  expect(writes[0].data.status).toBe("completed");
  expect(writes[0].data.result).toContain("Target detached");
  expect(writes[1].data.result).toBe(writes[0].data.result);
  expect(delivered).toBe(writes[0].data.result);
});
