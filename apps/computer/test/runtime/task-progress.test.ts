import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { compactionObservation } from "../../src/runtime/compaction";

const input = {
  key: "generated",
  state: "working",
  summary: "Generated the requested artifact",
  evidence: ["/documents/export"],
  remaining: ["Confirm destination receipt"],
  nextAction: "Check receipt",
};
test("worker progress keeps the turn alive, waiting parks it, and compaction sees the latest obligations", async () => {
  let deferred = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { arguments: args } = (await req.json()) as { arguments: Record<string, unknown> };
      return Response.json({
        saved: true,
        deferred,
        progress: { ...args, runId: "run", revision: deferred ? 2 : 1 },
      });
    },
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const turn = {
      requestSource: "agent",
      runtimeProfile: "subagent",
      subagentType: "executor",
      pluginNamespaces: [],
      botId: "child",
      instructions: "Original authorization and scope.",
      modelRef: {},
      reasoning: "low",
      compactionReadPiMessages: () => [],
      cwd: "/tmp",
      contextSessionId: "context",
    } as unknown as ActiveTurn;
    const progress = tools.customTools(turn).find((t) => t.name === "ReportTaskProgress")!;
    expect(progress).toBeDefined();
    await progress.execute("progress", input, undefined, undefined, {} as never);
    expect(turn.endTurnRequested).not.toBe(true);
    expect(compactionObservation(turn).systemPrompt).toContain("Confirm destination receipt");
    expect(compactionObservation(turn).systemPrompt).toContain("Original authorization and scope.");
    deferred = true;
    await progress.execute(
      "wait",
      { ...input, state: "waiting", checkAt: new Date(Date.now() + 3600_000).toISOString() },
      undefined,
      undefined,
      {} as never
    );
    expect(turn.endTurnRequested).toBe(true);
    expect(turn.instructions.split("<durable_task_state>")).toHaveLength(2);
  } finally {
    server.stop(true);
  }
});
test("only work-capable delegated workers hold progress; terminating WakeParent is unchanged", () => {
  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  for (const kind of ["executor", "knowledgeWork", "computerUse"]) {
    const turn = {
      requestSource: "agent",
      runtimeProfile: "subagent",
      subagentType: kind,
      pluginNamespaces: [],
    } as unknown as ActiveTurn;
    const names = tools.customTools(turn).map((t) => t.name);
    expect(names).toContain("ReportTaskProgress");
    expect(names).not.toContain("WakeParent");
  }
  const ordinary = {
    requestSource: "turn",
    runtimeProfile: "agent",
    subagentType: null,
    pluginNamespaces: [],
  } as unknown as ActiveTurn;
  expect(tools.customTools(ordinary).map((t) => t.name)).not.toContain("ReportTaskProgress");
});
test("a failed progress write neither ends the task nor invents saved state", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ error: "database unavailable" }, { status: 503 }),
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const turn = {
      requestSource: "agent",
      runtimeProfile: "subagent",
      subagentType: "computerUse",
      pluginNamespaces: [],
      botId: "child",
      instructions: "Original scope",
    } as unknown as ActiveTurn;
    await expect(
      tools
        .customTools(turn)
        .find((t) => t.name === "ReportTaskProgress")!
        .execute("failed", input, undefined, undefined, {} as never)
    ).rejects.toThrow();
    expect(turn.endTurnRequested).not.toBe(true);
    expect(turn.instructions).toBe("Original scope");
  } finally {
    server.stop(true);
  }
});

test("a parent saves a separate request wait, carries it into compaction, and workers cannot access that operation", async () => {
  const requestId = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const request = await req.json() as any;
      expect(request.tool).toBe("ReportRequestProgress");
      return Response.json({ request_run_id: requestId, deferred: request.arguments.state === "waiting", ended: request.arguments.state === "complete",
        requests: request.arguments.state === "complete" ? [] : [{ request_run_id: requestId, progress: request.arguments }] });
    },
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const active = { requestSource: "turn", runtimeProfile: "agent", subagentType: null,
      pluginNamespaces: [], botId: "owner", instructions: "Only one outgoing message is approved.",
      modelRef: {}, reasoning: "low", compactionReadPiMessages: () => [], cwd: "/tmp", contextSessionId: "context" } as unknown as ActiveTurn;
    const operation = tools.customTools(active).find(t => t.name === "ReportRequestProgress")!;
    expect(operation).toBeDefined();
    const waiting = await operation.execute("wait", { ...input, state: "waiting", checkAt: new Date(Date.now() + 3600_000).toISOString() }, undefined, undefined, {} as never);
    expect((waiting as any).terminate).toBe(true);
    expect(active.endTurnRequested).toBe(true);
    const snapshot = compactionObservation(active).systemPrompt;
    expect(snapshot).toContain(requestId);
    expect(snapshot).toContain("Confirm destination receipt");
    expect(snapshot).toContain("Only one outgoing message is approved.");
    const next = { ...active, endTurnRequested: false };
    const complete = await tools.customTools(next).find(t => t.name === "ReportRequestProgress")!
      .execute("complete", { ...input, state: "complete", remaining: [] }, undefined, undefined, {} as never);
    expect((complete as any).terminate).toBe(true);
    expect(next.endTurnRequested).toBe(true);
    expect(tools.customTools({ ...active, runtimeProfile: "subagent", subagentType: "executor" }).map(t => t.name)).not.toContain("ReportRequestProgress");
    expect(tools.customTools({ ...active, requestSource: "automation" }).map(t => t.name)).not.toContain("ReportRequestProgress");
  } finally { server.stop(true); }
});
