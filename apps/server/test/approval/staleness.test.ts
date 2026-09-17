import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RunService } from "../../src/services/run-service";

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

  test("forwards persistent local-computer decisions and records their durable resolution", async () => {
    for (const [decision, expectedStatus] of [
      ["always_allow", "accepted"],
      ["never", "declined"],
    ] as const) {
      const updates: Array<Record<string, unknown>> = [];
      const forwarded: Array<Record<string, unknown>> = [];
      const tx = {
        approval: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updates.push(data);
            return data;
          },
        },
        run: { updateMany: async () => ({count:1}) },
        event: { create: async () => ({}) },
      };
      const prisma = {
        approval: {
          findUnique: async () => ({
            id: `approval-${decision}`,
            runId: "run-1",
            upstreamRequestId: `runtime-${decision}`,
            requestMethod: "openteam/localTool",
            status: "pending",
            details: { type: "localTool", machineId: "machine-1" },
          }),
        },
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      };
      const service = new RunService(prisma as never, async (_path, init) => {
        forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true });
      });

      expect(
        await Effect.runPromise(service.resolveApproval(`approval-${decision}`, decision))
      ).toMatchObject({ status: expectedStatus });
      expect(forwarded).toEqual([{ approvalId: `runtime-${decision}`, decision }]);
      expect(updates[0]).toMatchObject({
        status: expectedStatus,
        decision,
        details: { type: "localTool", machineId: "machine-1", resolution: decision },
      });
    }
  });
});

test("native cookie approval forwards the selected scope and rejects unreviewed sites", async () => {
  const forwarded: unknown[] = [], updates: any[] = [];
  const details = { type: "nativeCapability", supportsAlwaysAllow: true, presentation: { kind: "cookie-import", items: [{ origin: ".alpha.test", profileId: "Default", profileDisplayName: "Personal" }] } };
  const tx = { $executeRaw: async (_sql: unknown, status: string, decision: string, patch: string) => updates.push({status, decision, details: {...details, ...JSON.parse(patch)}}), approval: { update: async ({ data }: any) => updates.push(data) }, run: { updateMany: async () => ({count:1}) }, event: { create: async () => ({}) } };
  const prisma = { approval: { findUnique: async () => ({ id: "approval", runId: "run", upstreamRequestId: "runtime", requestMethod: "openteam/capability", status: "pending", details }) }, $transaction: async (f: any) => f(tx) };
  const service = new RunService(prisma as never, async (_path, init) => { forwarded.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); });
  const selectedItems = [JSON.stringify(["Default", ".alpha.test"])];
  expect(await Effect.runPromise(service.resolveApproval("approval", "always_allow", selectedItems))).toMatchObject({ status: "accepted" });
  expect(forwarded).toEqual([{ approvalId: "runtime", decision: "always_allow", selectedItems }]);
  expect(updates[0].details.selectedItems).toEqual(selectedItems);
  await expect(Effect.runPromise(service.resolveApproval("approval", "accept", ["unreviewed"]))).rejects.toThrow("Select only sites");
  await expect(Effect.runPromise(service.resolveApproval("approval", "accept", []))).rejects.toThrow("Select only sites");
  details.supportsAlwaysAllow = false;
  await expect(Effect.runPromise(service.resolveApproval("approval", "always_allow", selectedItems))).rejects.toThrow("not supported");
  expect(forwarded).toHaveLength(1);
});
