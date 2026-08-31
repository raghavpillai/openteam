import { ApiError, type ApprovalDecision } from "@openbot/contracts";
import type { ApprovalStatus, PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import { appendEvent, type ComputerFetch, toError } from "./service-utils";

export class RunService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly computerFetch: ComputerFetch,
    private readonly resolvePluginInvocation?: (
      callId: string,
      decision: "accept" | "decline" | "cancel"
    ) => Promise<unknown>,
    private readonly resolvePluginAction?: (
      details: unknown,
      decision: "accept" | "decline" | "cancel"
    ) => Promise<unknown>,
    private readonly persistPluginToolAllowance?: (
      connectionId: string,
      botId: string,
      toolName: string
    ) => Promise<unknown>
  ) {}

  cancel = (runId: string) =>
    Effect.tryPromise({
      try: async () => {
        const run = await this.prisma.run.findUnique({ where: { id: runId } });
        if (!run) throw new ApiError(404, "run_not_found", "Run not found");
        if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
          return { ok: true, status: run.status };
        }
        if (run.status === "queued") {
          const completedAt = new Date();
          await this.prisma.$transaction(async (tx) => {
            await tx.run.updateMany({
              where: { id: runId, status: "queued" },
              data: {
                status: "cancelled",
                completedAt,
                error: {
                  code: "cancelled_by_user",
                  message: "Cancelled before execution",
                },
              },
            });
            await tx.inboxEvent.updateMany({
              where: { runId, deliveryMode: "turn", status: "pending" },
              data: {
                status: "completed",
                completedAt,
                error: {
                  code: "cancelled_by_user",
                  message: "Cancelled before execution",
                },
              },
            });
            await appendEvent(tx, "run.cancelled", runId, {
              runId,
              beforeExecution: true,
            });
          });
          await this.stopForegroundChildren(runId);
          return { ok: true, status: "cancelled" };
        }
        const response = await this.computerFetch(`/v1/turns/${runId}/cancel`, {
          method: "POST",
        });
        if (!response.ok) throw new ApiError(409, "run_not_active", await response.text());
        await this.prisma.$transaction(async (tx) => {
          await tx.run.update({
            where: { id: runId },
            data: { status: "cancelled" },
          });
          await appendEvent(tx, "run.cancel_requested", runId, { runId });
        });
        await this.stopForegroundChildren(runId);
        return { ok: true, status: "cancelled" };
      },
      catch: toError,
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
    if (children.length === 0) return;
    const stoppedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const child of children) {
        await tx.subagentAttempt.updateMany({
          where: {
            id: child.id,
            status: { in: ["provisioning", "queued", "running"] },
          },
          data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
        });
        await tx.subagent.updateMany({
          where: {
            id: child.subagent.id,
            currentRunId: child.childRunId,
            status: { in: ["provisioning", "queued", "running"] },
          },
          data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
        });
        if (child.childRunId) {
          await tx.run.updateMany({
            where: {
              id: child.childRunId,
              status: { in: ["queued", "running", "waiting_approval"] },
            },
            data: {
              status: "cancelled",
              completedAt: stoppedAt,
              error: {
                code: "parent_turn_cancelled",
                message: "The foreground parent turn was stopped",
              },
            },
          });
          await tx.inboxEvent.updateMany({
            where: {
              runId: child.childRunId,
              status: { in: ["pending", "processing"] },
            },
            data: {
              status: "completed",
              completedAt: stoppedAt,
              error: { code: "parent_turn_cancelled" },
            },
          });
          await tx.approval.updateMany({
            where: { runId: child.childRunId, status: "pending" },
            data: { status: "expired", resolvedAt: stoppedAt },
          });
        }
        await appendEvent(tx, "subagent.stopped", child.subagent.id, {
          subagentId: child.subagent.id,
          attemptId: child.id,
          parentRunId,
          runId: child.childRunId,
          reason: "parent_turn_cancelled",
        });
      }
    });
    await Promise.all(
      children.flatMap((child) =>
        child.childRunId
          ? [
              this.computerFetch(`/v1/turns/${child.childRunId}/cancel`, {
                method: "POST",
              }).catch(() => undefined),
            ]
          : []
      )
    );
  }

  resolveApproval = (approvalId: string, decision: ApprovalDecision) =>
    Effect.tryPromise({
      try: async () => {
        const approval = await this.prisma.approval.findUnique({
          where: { id: approvalId },
        });
        if (!approval) throw new ApiError(404, "approval_not_found", "Approval not found");
        if (approval.status !== "pending") return { ok: true, status: approval.status };
        if (approval.requestMethod === "plugin/action") {
          if (decision === "always_allow" || decision === "never") {
            throw new ApiError(
              400,
              "approval_decision_unsupported",
              "This action cannot be always allowed"
            );
          }
          const status: ApprovalStatus =
            decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
          const result = await this.resolvePluginAction?.(approval.details, decision);
          await this.prisma.$transaction(async (tx) => {
            await tx.approval.update({
              where: { id: approvalId },
              data: { status, decision, resolvedAt: new Date() },
            });
            await appendEvent(tx, "plugin.action.resolved", approvalId, {
              approvalId,
              decision,
            });
          });
          return { ok: true, status, result };
        }
        if (approval.requestMethod === "plugin/tool") {
          if (decision === "never") {
            throw new ApiError(
              400,
              "approval_decision_unsupported",
              "Never is only supported for local computer approvals"
            );
          }
          const status: ApprovalStatus =
            decision === "accept" || decision === "always_allow"
              ? "accepted"
              : decision === "decline"
                ? "declined"
                : "cancelled";
          const details =
            approval.details &&
            typeof approval.details === "object" &&
            !Array.isArray(approval.details)
              ? (approval.details as Record<string, unknown>)
              : {};
          const connectionId = details.connectionId;
          const botId = details.botId;
          const toolName = details.toolName;
          const pluginInvocationId = details.pluginInvocationId;
          if (
            typeof connectionId !== "string" ||
            typeof botId !== "string" ||
            typeof toolName !== "string" ||
            typeof pluginInvocationId !== "string"
          ) {
            throw new ApiError(409, "approval_invalid", "Plugin approval details are incomplete");
          }
          if (decision === "always_allow") {
            await this.persistPluginToolAllowance?.(connectionId, botId, toolName);
          }
          const invocationDecision = decision === "always_allow" ? "accept" : decision;
          const result = await this.resolvePluginInvocation?.(
            pluginInvocationId,
            invocationDecision
          );
          await this.prisma.$transaction(async (tx) => {
            await tx.approval.update({
              where: { id: approvalId },
              data: { status, decision, resolvedAt: new Date() },
            });
            await tx.pluginActivity.create({
              data: {
                connectionId,
                botId,
                kind: `approval.${status}`,
                summary: `${toolName} approval ${status}`,
              },
            });
            await appendEvent(tx, "plugin.approval.resolved", approvalId, {
              approvalId,
              connectionId,
              botId,
              toolName,
              decision,
            });
          });
          return { ok: true, status, result };
        }
        const localComputerApproval = ["openbot/localTool", "openbot/autoReview"].includes(
          approval.requestMethod
        );
        if ((decision === "always_allow" || decision === "never") && !localComputerApproval) {
          throw new ApiError(
            400,
            "approval_decision_unsupported",
            "This approval decision is not supported"
          );
        }
        const response = await this.computerFetch("/v1/approvals/resolve", {
          method: "POST",
          body: JSON.stringify({
            approvalId: approval.upstreamRequestId,
            decision,
          }),
        });
        if (!response.ok) {
          const resolvedAt = new Date();
          await this.prisma.$transaction(async (tx) => {
            await tx.approval.updateMany({
              where: { id: approvalId, status: "pending" },
              data: { status: "expired", resolvedAt },
            });
            await appendEvent(tx, "approval.stale", approvalId, {
              approvalId,
              runId: approval.runId,
            });
          });
          throw new ApiError(
            409,
            "approval_expired",
            "The runtime no longer accepts this approval"
          );
        }
        const status: ApprovalStatus =
          decision === "accept" || decision === "always_allow"
            ? "accepted"
            : decision === "decline" || decision === "never"
              ? "declined"
              : "cancelled";
        await this.prisma.$transaction(async (tx) => {
          const details =
            approval.details &&
            typeof approval.details === "object" &&
            !Array.isArray(approval.details)
              ? {
                  ...(approval.details as Record<string, unknown>),
                  resolution: decision,
                }
              : { resolution: decision };
          await tx.approval.update({
            where: { id: approvalId },
            data: { status, decision, details, resolvedAt: new Date() },
          });
          await tx.run.update({
            where: { id: approval.runId },
            data: { status: "running" },
          });
          await appendEvent(tx, "approval.resolved", approvalId, {
            approvalId,
            runId: approval.runId,
            decision,
          });
        });
        return { ok: true, status };
      },
      catch: toError,
    });
}
