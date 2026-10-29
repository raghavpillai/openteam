import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SubagentService } from "../../src/services/subagent/service";

function fixture() {
  const runs: Record<string, { id: string; botId: string; status: string }> = {
    main: { id: "main", botId: "bot", status: "running" },
    workerRun: { id: "workerRun", botId: "worker-bot", status: "running" },
    otherRun: { id: "otherRun", botId: "other-bot", status: "running" },
  };
  const subagents = [
    { id: "worker", parentBotId: "bot", childBotId: "worker-bot", currentRunId: "workerRun", status: "running", subagentType: "executor", prompt: "Watch the tick loop", createdAt: new Date(1) },
    { id: "other", parentBotId: "bot", childBotId: "other-bot", currentRunId: "otherRun", status: "running", subagentType: "executor", prompt: "Research cities", createdAt: new Date(2) },
  ];
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]: any) =>
    value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value);
  const events: any[] = [];
  const cancelled: string[] = [];
  const shellStops: string[] = [];
  const db: any = {
    $executeRaw: async () => 1,
    bot: { findUnique: async ({ where }: any) => (["bot", "idle-bot"].includes(where.id) ? { id: where.id } : null) },
    run: {
      findUnique: async ({ where }: any) => (runs[where.id] ? { ...runs[where.id], inboxEvents: [] } : null),
      findMany: async ({ where }: any) => where.requestProgress ? [] : Object.values(runs).filter((row) => matches(row, where)).map(({ id }) => ({ id })),
    },
    subagent: {
      findFirst: async ({ where }: any) => subagents.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => subagents.filter((row) => matches(row, where)),
      findUnique: async ({ where }: any) => subagents.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const rows = subagents.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    subagentAttempt: { updateMany: async () => ({ count: 1 }) },
    event: { create: async ({ data }: any) => events.push(data) },
  };
  db.$transaction = async (fn: any) => fn(db);
  const runService: any = {
    cancel: (id: string) => Effect.sync(() => {
      cancelled.push(id);
      runs[id]!.status = "cancelled";
      return { ok: true, status: "cancelled" };
    }),
  };
  const computerFetch = async (path: string) => {
    shellStops.push(path);
    return new Response('{"stopped":1}');
  };
  const service = new SubagentService(db, {} as never, runService, "/workspace", computerFetch, {} as never);
  return { service, runs, subagents, events, cancelled, shellStops };
}

test("stopping a worker's run stops that worker for good: its shells end and it won't report back", async () => {
  const f = fixture();
  const result = await Effect.runPromise(f.service.stopRun("workerRun"));
  expect(result).toEqual({ ok: true, status: "cancelled" });
  expect(f.cancelled).toEqual(["workerRun"]);
  expect(f.shellStops).toHaveLength(1);
  expect(f.shellStops[0]).toContain("worker-bot");
  expect(f.subagents.map((row) => row.status)).toEqual(["stopped", "running"]);
  expect(f.events.map((event) => event.topic)).toEqual(["subagent.stopped"]);
});

test("stopping a bot's run also stops every subagent it has running", async () => {
  const f = fixture();
  await Effect.runPromise(f.service.stopRun("main"));
  expect(f.cancelled).toEqual(["main", "workerRun", "otherRun"]);
  expect(f.shellStops).toHaveLength(2);
  expect(f.subagents.map((row) => row.status)).toEqual(["stopped", "stopped"]);
});

test("a stop of a bot's finished run leaves its subagents alone", async () => {
  const f = fixture();
  f.runs.main!.status = "completed";
  await Effect.runPromise(f.service.stopRun("main"));
  expect(f.cancelled).toEqual(["main"]);
  expect(f.subagents.map((row) => row.status)).toEqual(["running", "running"]);
});

test("a worker the worker process already recorded as stopped still counts as stopped", async () => {
  const f = fixture();
  f.service["runs"].cancel = (id: string) => Effect.sync(() => {
    f.runs[id]!.status = "cancelled";
    // The cancelled turn settles first and the worker marks the subagent stopped.
    f.subagents[0]!.status = "stopped";
    return { ok: true, status: "cancelled" };
  });
  const result = await (f.service as any).stop("bot", "call", { subagent_id: "sand-subagent-worker" });
  expect(result).toMatchObject({ stopped: true, status: "stopped" });
});

test("unknown runs are not found", async () => {
  const f = fixture();
  await expect(Effect.runPromise(f.service.stopRun("missing"))).rejects.toThrow("Run not found");
});

test("stopping a bot stops its turn and every subagent it has running, without posting anything", async () => {
  const f = fixture();
  const result = await Effect.runPromise(f.service.stopBot("bot"));
  expect(result).toEqual({ hadActiveRun: true });
  expect(f.cancelled).toEqual(["main", "workerRun", "otherRun"]);
  expect(f.subagents.map((row) => row.status)).toEqual(["stopped", "stopped"]);
  expect(f.events.map((event) => event.topic)).toEqual(["subagent.stopped", "subagent.stopped"]);
});

test("stopping a bot whose turn ended stops the subagents still working in the background", async () => {
  const f = fixture();
  f.runs.main!.status = "completed";
  const result = await Effect.runPromise(f.service.stopBot("bot"));
  expect(result).toEqual({ hadActiveRun: true });
  expect(f.cancelled).toEqual(["workerRun", "otherRun"]);
  expect(f.subagents.map((row) => row.status)).toEqual(["stopped", "stopped"]);
});

test("stopping an idle bot changes nothing", async () => {
  const f = fixture();
  const result = await Effect.runPromise(f.service.stopBot("idle-bot"));
  expect(result).toEqual({ hadActiveRun: false });
  expect(f.cancelled).toEqual([]);
  expect(f.shellStops).toEqual([]);
});

test("unknown bots are not found", async () => {
  const f = fixture();
  await expect(Effect.runPromise(f.service.stopBot("missing"))).rejects.toThrow("Bot not found");
});
