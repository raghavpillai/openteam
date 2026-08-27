import { ApiError } from "@openbot/contracts";
import { type ApprovalStatus, type PrismaClient } from "@openbot/db";
import type { AgentMessaging } from "@openbot/messaging";
import { Effect } from "effect";
import { appendEvent, type ComputerFetch, toError } from "./service-utils";

export class RunService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly computerFetch: ComputerFetch
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
                error: { code: "cancelled_by_user", message: "Cancelled before execution" },
              },
            });
            await tx.inboxEvent.updateMany({
              where: { runId, deliveryMode: "turn", status: "pending" },
              data: {
                status: "completed",
                completedAt,
                error: { code: "cancelled_by_user", message: "Cancelled before execution" },
              },
            });
            await appendEvent(tx, "run.cancelled", runId, { runId, beforeExecution: true });
          });
          return { ok: true, status: "cancelled" };
        }
        const response = await this.computerFetch(`/v1/turns/${runId}/cancel`, { method: "POST" });
        if (!response.ok) throw new ApiError(409, "run_not_active", await response.text());
        await this.prisma.$transaction(async (tx) => {
          await tx.run.update({ where: { id: runId }, data: { status: "cancelled" } });
          await appendEvent(tx, "run.cancel_requested", runId, { runId });
        });
        return { ok: true, status: "cancelled" };
      },
      catch: toError,
    });

  resolveApproval = (approvalId: string, decision: "accept" | "decline" | "cancel") =>
    Effect.tryPromise({
      try: async () => {
        const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
        if (!approval) throw new ApiError(404, "approval_not_found", "Approval not found");
        if (approval.status !== "pending") return { ok: true, status: approval.status };
        if (approval.requestMethod === "plugin/tool") {
          const status: ApprovalStatus =
            decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
          const details =
            approval.details &&
            typeof approval.details === "object" &&
            !Array.isArray(approval.details)
              ? (approval.details as Record<string, unknown>)
              : {};
          const connectionId = details.connectionId;
          const botId = details.botId;
          const toolName = details.toolName;
          if (
            typeof connectionId !== "string" ||
            typeof botId !== "string" ||
            typeof toolName !== "string"
          ) {
            throw new ApiError(409, "approval_invalid", "Plugin approval details are incomplete");
          }
          await this.prisma.$transaction(async (tx) => {
            await tx.approval.update({
              where: { id: approvalId },
              data: { status, decision, resolvedAt: new Date() },
            });
            if (decision === "accept") {
              const existing = await tx.pluginToolPolicy.findFirst({
                where: { connectionId, botId, toolName },
              });
              if (existing) {
                await tx.pluginToolPolicy.update({
                  where: { id: existing.id },
                  data: { decision: "allow" },
                });
              } else {
                await tx.pluginToolPolicy.create({
                  data: { connectionId, botId, toolName, decision: "allow" },
                });
              }
            }
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
          return { ok: true, status };
        }
        const response = await this.computerFetch("/v1/approvals/resolve", {
          method: "POST",
          body: JSON.stringify({ approvalId: approval.upstreamRequestId, decision }),
        });
        if (!response.ok) {
          throw new ApiError(
            409,
            "approval_expired",
            "The runtime no longer accepts this approval"
          );
        }
        const status: ApprovalStatus =
          decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
        await this.prisma.$transaction(async (tx) => {
          await tx.approval.update({
            where: { id: approvalId },
            data: { status, decision, resolvedAt: new Date() },
          });
          await tx.run.update({ where: { id: approval.runId }, data: { status: "running" } });
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

  compactConversation = (conversationId: string) =>
    Effect.tryPromise({
      try: async () => {
        const conversation = await this.prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { bot: true },
        });
        if (!conversation?.bot.runtimeSessionPath) {
          throw new ApiError(409, "session_not_attached", "This bot has no Pi session yet");
        }
        const instructions = await this.messaging.platformInstructions(conversation.botId);
        const response = await this.computerFetch("/v1/compact", {
          method: "POST",
          body: JSON.stringify({
            botId: conversation.botId,
            sessionPath: conversation.bot.runtimeSessionPath,
            cwd: conversation.bot.defaultDirectory,
            instructions,
          }),
        });
        if (!response.ok) throw new ApiError(503, "computer_unavailable", await response.text());
        return { ok: true };
      },
      catch: toError,
    });
}
