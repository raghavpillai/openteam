import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RunService } from "../src/services/run-service";

describe("parent run cancellation", () => {
  test("stops foreground children while leaving background children alive", async () => {
    const stoppedSubagents: string[] = [];
    const stoppedAttempts: string[] = [];
    const cancelledChildRuns: string[] = [];
    const children = [
      {
        id: "foreground-attempt",
        childRunId: "foreground-run",
        runInBackground: false,
        subagent: { id: "foreground-child", currentRunId: "foreground-run" },
      },
      {
        id: "background-attempt",
        childRunId: "background-run",
        runInBackground: true,
        subagent: { id: "background-child", currentRunId: "background-run" },
      },
    ];
    const tx = {
      run: { updateMany: async () => ({ count: 1 }) },
      inboxEvent: { updateMany: async () => ({ count: 1 }) },
      approval: { updateMany: async () => ({ count: 0 }) },
      subagent: {
        updateMany: async ({ where }: { where: { id: string } }) => {
          stoppedSubagents.push(where.id);
          return { count: 1 };
        },
      },
      subagentAttempt: {
        updateMany: async ({ where }: { where: { id: string } }) => {
          stoppedAttempts.push(where.id);
          return { count: 1 };
        },
      },
      event: { create: async () => ({ id: "event" }) },
    };
    const prisma = {
      run: {
        findUnique: async () => ({ id: "parent-run", status: "queued" }),
      },
      inboxEvent: tx.inboxEvent,
      subagentAttempt: {
        findMany: async ({ where }: { where: { runInBackground: boolean } }) => {
          expect(where.runInBackground).toBe(false);
          return children.filter((child) => child.runInBackground === where.runInBackground);
        },
      },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    };
    const service = new RunService(prisma as never, async (path) => {
      cancelledChildRuns.push(path);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    expect(await Effect.runPromise(service.cancel("parent-run"))).toMatchObject({
      status: "cancelled",
    });
    expect(stoppedSubagents).toEqual(["foreground-child"]);
    expect(stoppedAttempts).toEqual(["foreground-attempt"]);
    expect(cancelledChildRuns).toEqual(["/v1/turns/foreground-run/cancel"]);
  });
});
