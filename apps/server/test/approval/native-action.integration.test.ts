import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { parseComputerEvent } from "@openteam/contracts/service-protocol";
import { nativeApprovalOutcome } from "../../../../packages/product-core/src/activity";
import { Projection } from "../../../worker/src/projection";
import { RunService } from "../../src/services/run-service";
import { approvalViews } from "../../src/services/approval-view";
import { Effect } from "effect";

const action = (approvalId: string, status: "running" | "completed" | "failed") =>
  parseComputerEvent({
    type: "approval.action",
    approvalId,
    turnId: "fixture",
    status,
    decision: "accept",
    unexpectedSecret: "SYNTHETIC-PRIVATE-TEST-VALUE",
  });
test("native approval events whitelist public metadata and reject invalid decisions", () => {
  expect(action("request", "running")).toEqual({
    type: "approval.action",
    approvalId: "request",
    turnId: "fixture",
    status: "running",
    decision: "accept",
  });
  expect(() =>
    parseComputerEvent({
      type: "approval.action",
      approvalId: "x",
      turnId: "t",
      status: "bad",
      decision: "accept",
    })
  ).toThrow();
  expect(() =>
    parseComputerEvent({
      type: "approval.action",
      approvalId: "x",
      turnId: "t",
      status: "running",
      decision: "decline",
    })
  ).toThrow();
});

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "native action states survive fast fills, reloads, replay, failure, cancellation and delayed HTTP decisions",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const botId = crypto.randomUUID(),
      conversationId = crypto.randomUUID(),
      runId = crypto.randomUUID();
    const projection = new Projection(db);
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "Native lifecycle fixture",
          defaultDirectory: "/tmp",
          notificationsEnabled: false,
          conversation: { create: { id: conversationId } },
        },
      });
      const trigger = await db.message.create({
        data: { botId, conversationId, role: "user", content: "Synthetic login test" },
      });
      await db.run.create({
        data: {
          id: runId,
          botId,
          conversationId,
          userMessageId: trigger.id,
          status: "running",
          origin: "user",
        },
      });
      const request = async (id: string) => {
        await db.run.update({ where: { id: runId }, data: { status: "running" } });
        await projection.apply(runId, conversationId, botId, {
          type: "approval.requested",
          approvalId: id,
          turnId: "fixture",
          itemId: id,
          requestMethod: "openteam/capability",
          details: {
            type: "nativeCapability",
            presentation: {
              kind: "saved-login",
              title: "Synthetic login",
              site: "https://example.test",
              category: "LOGIN",
              purpose: "Test only",
            },
          },
        });
        return db.approval.findUniqueOrThrow({ where: { upstreamRequestId: id } });
      };
      const first = await request("first");
      await projection.apply(runId, conversationId, botId, action("first", "running"));
      expect(
        nativeApprovalOutcome(await db.approval.findUniqueOrThrow({ where: { id: first.id } }))
      ).toMatchObject({ filling: true, pending: false });
      // Replay starts cannot undo the completed result, including after a worker restart.
      await projection.apply(runId, conversationId, botId, action("first", "completed"));
      await new Projection(db).apply(runId, conversationId, botId, action("first", "running"));
      expect(
        nativeApprovalOutcome(await db.approval.findUniqueOrThrow({ where: { id: first.id } }))
      ).toMatchObject({ filling: false, status: "Allowed once" });
      const racing = await request("racing");
      const service = new RunService(db, async () => {
        await projection.apply(runId, conversationId, botId, action("racing", "running"));
        await projection.apply(runId, conversationId, botId, action("racing", "completed"));
        await projection.apply(runId, conversationId, botId, {
          type: "turn.completed",
          turnId: "fixture",
          status: "completed",
        });
        return Response.json({ ok: true });
      });
      await Effect.runPromise(service.resolveApproval(racing.id, "accept"));
      expect(
        (await db.approval.findUniqueOrThrow({ where: { id: racing.id } })).details
      ).toMatchObject({ actionState: "completed", resolution: "accept" });
      expect((await db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("completed");
      const failed = await request("failed");
      await projection.apply(runId, conversationId, botId, action("failed", "running"));
      await projection.apply(
        crypto.randomUUID(),
        conversationId,
        botId,
        action("failed", "completed")
      );
      await projection.apply(runId, conversationId, botId, action("failed", "failed"));
      await projection.apply(runId, conversationId, botId, action("failed", "completed"));
      expect(
        nativeApprovalOutcome(await db.approval.findUniqueOrThrow({ where: { id: failed.id } }))
      ).toMatchObject({ failed: true, filling: false, status: "Failed" });
      const cancelled = await request("cancelled");
      await projection.apply(runId, conversationId, botId, action("cancelled", "running"));
      const running = await db.approval.findUniqueOrThrow({ where: { id: cancelled.id } });
      expect(
        (
          approvalViews([running], [{ id: runId, conversationId, status: "interrupted" }], [])[0]!
            .details as any
        ).actionState
      ).toBe("failed");
      await projection.apply(runId, conversationId, botId, {
        type: "turn.completed",
        turnId: "fixture",
        status: "interrupted",
      });
      await projection.apply(runId, conversationId, botId, action("cancelled", "running"));
      expect(
        (await db.approval.findUniqueOrThrow({ where: { id: cancelled.id } })).details
      ).toMatchObject({ actionState: "failed" });
      const cookies = await request("cookies");
      const offered = [
        { origin: ".alpha.test", profileId: "Default", profileDisplayName: "Personal" },
        { origin: ".beta.test", profileId: "Default", profileDisplayName: "Personal" },
      ];
      await db.approval.update({
        where: { id: cookies.id },
        data: {
          details: {
            type: "nativeCapability",
            supportsAlwaysAllow: true,
            presentation: { kind: "cookie-import", items: offered },
          },
        },
      });
      const selectedItems = [JSON.stringify(["Default", ".alpha.test"])];
      await projection.apply(runId, conversationId, botId, {
        type: "approval.action",
        approvalId: "cookies",
        turnId: "fixture",
        status: "running",
        decision: "always_allow",
        selectedItems,
      });
      await projection.apply(runId, conversationId, botId, {
        type: "approval.action",
        approvalId: "cookies",
        turnId: "fixture",
        status: "completed",
        decision: "always_allow",
        selectedItems,
      });
      expect(
        (await db.approval.findUniqueOrThrow({ where: { id: cookies.id } })).details
      ).toMatchObject({ actionState: "completed", resolution: "always_allow", selectedItems });
      await expect(
        projection.apply(runId, conversationId, botId, {
          type: "approval.action",
          approvalId: "cookies",
          turnId: "fixture",
          status: "running",
          decision: "accept",
          selectedItems: ["unreviewed"],
        })
      ).rejects.toThrow("unreviewed");
      const denied = await request("denied");
      await db.approval.update({ where: { id: denied.id }, data: { status: "declined" } });
      await projection.apply(runId, conversationId, botId, action("denied", "running"));
      expect(
        nativeApprovalOutcome(await db.approval.findUniqueOrThrow({ where: { id: denied.id } }))
      ).toMatchObject({ pending: false, filling: false, status: "Denied" });
      const stored = JSON.stringify(
        await db.event.findMany({ where: { entityId: runId } }),
        (_, v) => (typeof v === "bigint" ? String(v) : v)
      );
      expect(stored).not.toContain("SYNTHETIC-PRIVATE-TEST-VALUE");
    } finally {
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  },
  20000
);
