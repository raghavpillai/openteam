import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RunService } from "../src/services/run-service";

describe("approval restart parity", () => {
  test("turns a dead runtime approval into historical stale state on first action", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const tx = {
      approval: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { count: 1 };
        },
      },
      event: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        },
      },
    };
    const prisma = {
      approval: {
        findUnique: async () => ({
          id: "approval-1",
          runId: "child-run-1",
          runItemId: null,
          upstreamRequestId: "dead-runtime-request",
          requestMethod: "item/commandExecution/requestApproval",
          kind: "command",
          status: "pending",
          details: {},
        }),
      },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    };
    const service = new RunService(
      prisma as never,
      async () => new Response("stale", { status: 409 })
    );

    await expect(
      Effect.runPromise(service.resolveApproval("approval-1", "accept"))
    ).rejects.toThrow("The runtime no longer accepts this approval");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "expired" });
    expect(events[0]).toMatchObject({
      topic: "approval.stale",
      entityId: "approval-1",
      payload: { approvalId: "approval-1", runId: "child-run-1" },
    });
  });
});
