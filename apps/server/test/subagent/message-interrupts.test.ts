import { expect, test } from "bun:test";
import { SubagentService, subagentSteerPrompt } from "../../src/services/subagent/service";

/** A running worker with one in-flight turn, on an in-memory store. */
const fixture = (runStatus: "running" | "queued" = "running", inputDeliveredAt: Date | null = new Date()) => {
  const runs: Record<string, any> = { "turn-1": { id: "turn-1", status: runStatus, channelId: "child-dm", inputDeliveredAt } };
  const attempt: any = { id: "attempt", childRunId: "turn-1" };
  const subagent: any = { id: "child", childBotId: "child-bot", parentBotId: "parent", status: "running", currentRunId: "turn-1" };
  const inbox: any[] = [{ id: "inbox-turn-1", runId: "turn-1", type: "subagent.task", status: runStatus === "running" ? "processing" : "pending", payload: { messageId: "message-turn-1", content: "Compare the two plans." } }];
  const messages: Record<string, string> = { "message-turn-1": "Compare the two plans." };
  const events: any[] = [];
  const locks: string[] = [];
  const cancels: Array<{ path: string; body: unknown }> = [];
  const wakes: any[] = [];
  const db: any = {
    subagent: {
      findFirst: async () => subagent,
      findMany: async () => [],
      update: async ({ data }: any) => Object.assign(subagent, data),
      updateMany: async ({ where, data }: any) => {
        if (where.id !== subagent.id || where.currentRunId !== subagent.currentRunId || where.status !== subagent.status) return { count: 0 };
        Object.assign(subagent, data);
        return { count: 1 };
      },
    },
    run: {
      findUnique: async ({ where }: any) => runs[where.id] ?? null,
      updateMany: async ({ where, data }: any) => {
        const run = runs[where.id];
        if (!run || !where.status.in.includes(run.status)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    subagentAttempt: {
      findUnique: async ({ where }: any) => (where.childRunId === attempt.childRunId ? attempt : null),
      update: async ({ data }: any) => Object.assign(attempt, data),
    },
    inboxEvent: {
      findFirst: async ({ where }: any) => inbox.find((event) => event.runId === where.runId && (!where.type || event.type === where.type) && (!where.status || event.status === where.status)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const event = inbox.find((candidate) => candidate.id === where.id && candidate.status === where.status);
        if (!event) return { count: 0 };
        Object.assign(event, data);
        return { count: 1 };
      },
    },
    message: { update: async ({ where, data }: any) => { messages[where.id] = data.content; } },
    event: { create: async ({ data }: any) => events.push(data) },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { locks.push(strings.join("?").replace("?", String(values[0]))); },
  };
  db.$transaction = async (fn: any) => fn(db);
  const messaging: any = {
    enqueueWake: async (_tx: unknown, input: any) => {
      const id = `turn-${Object.keys(runs).length + 1}`;
      runs[id] = { id, status: "queued", channelId: input.channelId, inputDeliveredAt: null };
      inbox.push({ id: `inbox-${id}`, runId: id, type: input.type, status: "pending", payload: { messageId: `message-${id}`, content: input.content } });
      messages[`message-${id}`] = input.content;
      wakes.push(input);
      return { run: runs[id] };
    },
  };
  const computerFetch = async (path: string, init?: RequestInit) => {
    cancels.push({ path, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  };
  const service = new SubagentService(db, messaging, null as never, "/workspace", computerFetch as never, null as never);
  return { service, runs, attempt, subagent, inbox, messages, events, locks, cancels, wakes };
};

test("MessageSubagent interrupts the running worker turn and starts a new worker turn with the message, as the reference does", async () => {
  const f = fixture();
  const result: any = await f.service.message("parent", "call-1", { subagent_id: "sand-subagent-child", message: "  Check the second tab too.\n" });
  expect(f.wakes).toHaveLength(1);
  expect(f.wakes[0]).toMatchObject({ botId: "child-bot", channelId: "child-dm", origin: "agent", type: "subagent.steer" });
  expect(f.wakes[0].content).toBe(
    "[Steering message from the parent agent that dispatched you]\n\nCheck the second tab too.\n\nTake this into account and continue your task from where you are. Do not start over."
  );
  // The task's completion now comes from the new turn; the old one is cut off with the reference's reason.
  expect(f.attempt.childRunId).toBe("turn-2");
  expect(f.subagent.currentRunId).toBe("turn-2");
  expect(f.cancels).toEqual([{ path: "/v1/turns/turn-1/cancel", body: { reason: "parent_message" } }]);
  expect(f.runs["turn-1"]).toMatchObject({ status: "cancelled", error: { code: "superseded_by_parent", message: "Steering message from the parent agent." } });
  expect(result).toEqual({ delivered: true, subagent_id: "sand-subagent-child", run_id: "turn-2" });

  // A second message before that turn starts replaces it: the reference keeps only the latest.
  await f.service.message("parent", "call-2", { subagent_id: "sand-subagent-child", message: "Actually, only the first tab." });
  expect(f.wakes).toHaveLength(1);
  expect(f.cancels).toHaveLength(1);
  expect(f.inbox[1].payload.content).toBe(subagentSteerPrompt("Actually, only the first tab."));
  // Serialized with the worker's claim of the child's wakes.
  expect(f.locks).toEqual(["SELECT pg_advisory_xact_lock(hashtext(bot-run-claim:child-bot))", "SELECT pg_advisory_xact_lock(hashtext(bot-run-claim:child-bot))"]);
});

test("a message that loses the race with the worker claiming the pending turn starts a new turn instead of editing the claimed one", async () => {
  const f = fixture();
  await f.service.message("parent", "call-1", { subagent_id: "sand-subagent-child", message: "First." });
  // The worker claimed turn-2 before this message's transaction ran, but has not delivered it yet.
  Object.assign(f.inbox[1], { status: "processing" });
  Object.assign(f.runs["turn-2"], { status: "running" });
  const result: any = await f.service.message("parent", "call-2", { subagent_id: "sand-subagent-child", message: "Second." });
  expect(result.run_id).toBe("turn-3");
  expect(f.inbox[1].payload.content).toBe(subagentSteerPrompt("First."));
  expect(f.wakes[1].content).toBe(subagentSteerPrompt("Second."));
  expect(f.runs["turn-2"].status).toBe("cancelled");
  expect(f.subagent.currentRunId).toBe("turn-3");
});

test("a message racing the worker's completion is not delivered and does not move the finished worker to a new turn", async () => {
  const f = fixture();
  // The old turn's completion committed between the status read and the message's transaction.
  const findFirst = (f.service as any).prisma.subagent.findFirst;
  (f.service as any).prisma.subagent.findFirst = async () => { const found = { ...(await findFirst()) }; f.subagent.status = "completed"; return found; };
  const result = await f.service.message("parent", "call-1", { subagent_id: "sand-subagent-child", message: "Too late." });
  expect(result).toBe('No subagent "sand-subagent-child" is currently running. It may have already finished (you\'re revived automatically with a finished subagent\'s result), or the id is wrong. No subagents are running right now.');
  expect(f.subagent).toMatchObject({ status: "completed", currentRunId: "turn-1" });
  expect(f.attempt.childRunId).toBe("turn-1");
  expect(f.cancels).toEqual([]);
});
