import {
  ApiError,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import { Effect } from "effect";
import type { AgentMessaging } from "@openteam/messaging";
import { appendEvent, type ComputerFetch, serviceEffect } from "./service-utils";

export class RunService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly computerFetch: ComputerFetch,
  ) {}

  cancel = (runId: string) =>
    serviceEffect(async () => {
      let run = await this.prisma.run.findUnique({ where: { id: runId } });
      if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      if (run.status === "queued") {
        const completedAt = new Date();
        const cancelled = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.run.updateMany({
            where: { id: runId, status: "queued" },
            data: {
              status: "cancelled",
              completedAt,
              error: { code: "cancelled_by_user", message: "Cancelled before execution" },
            },
          });
          if (updated.count === 0) return false;
          await tx.inboxEvent.updateMany({
            where: { runId, deliveryMode: "turn", status: "pending" },
            data: {
              status: "completed",
              completedAt,
              error: { code: "cancelled_by_user", message: "Cancelled before execution" },
            },
          });
          await appendEvent(tx, "run.cancelled", runId, { runId, beforeExecution: true });
          return true;
        });
        if (cancelled) {
          await this.stopForegroundChildren(runId);
          return { ok: true, status: "cancelled" };
        }
        // A worker may have claimed the queued run before the conditional write.
        run = await this.prisma.run.findUnique({ where: { id: runId } });
        if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
        // Retrying a parent cancellation must retry children that failed to stop.
        await this.stopForegroundChildren(runId);
        return { ok: true, status: run.status };
      }
      try {
        const response = await this.computerFetch(COMPUTER_API_PATHS.turnCancel(runId), {
          method: "POST",
        });
        if (!response.ok) throw new ApiError(409, "run_not_active", await response.text());
      } catch (error) {
        const current = await this.prisma.run.findUnique({ where: { id: runId } });
        if (
          !current ||
          !["completed", "failed", "cancelled", "interrupted"].includes(current.status)
        )
          throw error;
        await this.stopForegroundChildren(runId);
        return { ok: true, status: current.status };
      }
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.run.updateMany({
          where: { id: runId, status: { in: ["queued", "running"] } },
          data: { status: "cancelled", completedAt: new Date() },
        });
        if (updated.count) await appendEvent(tx, "run.cancel_requested", runId, { runId });
      });
      await this.stopForegroundChildren(runId);
      const current = await this.prisma.run.findUnique({ where: { id: runId } });
      return { ok: true, status: current?.status ?? "cancelled" };
    });

  private async stopForegroundChildren(parentRunId: string): Promise<void> {
    const children = await this.prisma.subagentAttempt.findMany({
      where: {
        parentRunId,
        runInBackground: false,
        status: { in: ["provisioning", "queued", "running"] },
      },
      select: {
        id: true,
        childRunId: true,
        subagent: { select: { id: true, currentRunId: true } },
      },
    });
    const results = await Promise.allSettled(
      children.map(async (child) => {
        // Use the same checked cancellation path for queued and running children.
        // Do not claim the attempt stopped when its runtime did not acknowledge it.
        if (child.childRunId) await Effect.runPromise(this.cancel(child.childRunId));
        const stoppedAt = new Date();
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.subagentAttempt.updateMany({
            where: {
              id: child.id,
              childRunId: child.childRunId,
              status: { in: ["provisioning", "queued", "running"] },
            },
            data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
          });
          if (!updated.count) return;
          await tx.subagent.updateMany({
            where: {
              id: child.subagent.id,
              currentRunId: child.childRunId,
              status: { in: ["provisioning", "queued", "running"] },
            },
            data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
          });
          if (child.childRunId) {
            await tx.inboxEvent.updateMany({
              where: { runId: child.childRunId, status: { in: ["pending", "processing"] } },
              data: {
                status: "completed",
                completedAt: stoppedAt,
                error: { code: "parent_turn_cancelled" },
              },
            });
          }
          await appendEvent(tx, "subagent.stopped", child.subagent.id, {
            subagentId: child.subagent.id,
            attemptId: child.id,
            parentRunId,
            runId: child.childRunId,
            reason: "parent_turn_cancelled",
          });
        });
      })
    );
    if (results.some((result) => result.status === "rejected"))
      throw new ApiError(
        502,
        "child_cancellation_failed",
        "One or more foreground workers could not be stopped. Retry cancellation."
      );
  }


}
