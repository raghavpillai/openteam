import {
  ApiError,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
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
            where: { runId, status: "pending" },
            data: {
              status: "completed",
              completedAt,
              error: { code: "cancelled_by_user", message: "Cancelled before execution" },
            },
          });
          await appendEvent(tx, "run.cancelled", runId, { runId, beforeExecution: true });
          return true;
        });
        if (cancelled) return { ok: true, status: "cancelled" };
        // A worker may have claimed the queued run before the conditional write.
        run = await this.prisma.run.findUnique({ where: { id: runId } });
        if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
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
        return { ok: true, status: current.status };
      }
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.run.updateMany({
          where: { id: runId, status: { in: ["queued", "running"] } },
          data: { status: "cancelled", completedAt: new Date() },
        });
        if (updated.count) await appendEvent(tx, "run.cancel_requested", runId, { runId });
      });
      // Its subagents run in the background, as in the reference, and outlive the stop.
      const current = await this.prisma.run.findUnique({ where: { id: runId } });
      return { ok: true, status: current?.status ?? "cancelled" };
    });
}
