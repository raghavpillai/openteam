import { expect, test } from "bun:test";
import { SubagentService } from "../../src/services/subagent/service";

/** A running worker with one in-flight turn, on an in-memory store. */
const fixture = (runStatus: "running" | "queued" = "running") => {
  const runs: Record<string, any> = { "turn-1": { id: "turn-1", status: runStatus, channelId: "child-dm" } };
  const attempt: any = { id: "attempt", childRunId: "turn-1" };
  const subagent: any = { id: "child", childBotId: "child-bot", parentBotId: "parent", status: "running", currentRunId: "turn-1" };
  const inbox: any[] = [];
  const cancels: Array<{ path: string; body: unknown }> = [];
  const wakes: any[] = [];
  const db: any = {
    subagent: {
      findFirst: async () => subagent,
      update: async ({ data }: any) => Object.assign(subagent, data),
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
      findFirst: async ({ where }: any) => inbox.find((event) => event.runId === where.runId && event.type === where.type && event.status === where.status) ?? null,
      update: async ({ where, data }: any) => Object.assign(inbox.find((event) => event.id === where.id), data),
    },
    event: { create: async () => ({}) },
  };
  db.$transaction = async (fn: any) => fn(db);
  const messaging: any = {
    enqueueWake: async (_tx: unknown, input: any) => {
      const id = `turn-${Object.keys(runs).length + 1}`;
      runs[id] = { id, status: "queued", channelId: input.channelId };
      inbox.push({ id: `inbox-${id}`, runId: id, type: input.type, status: "pending", payload: { content: input.content } });
      wakes.push(input);
      return { run: runs[id] };
    },
  };
  const computerFetch = async (path: string, init?: RequestInit) => {
    cancels.push({ path, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  };
  const service = new SubagentService(db, messaging, null as never, "/workspace", computerFetch as never, null as never);
  return { service, runs, attempt, subagent, inbox, cancels, wakes };
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
  expect(f.inbox[0].payload.content).toContain("Actually, only the first tab.");
});
