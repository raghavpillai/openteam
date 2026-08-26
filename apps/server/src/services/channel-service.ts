import { resolve, sep } from "node:path";
import { ApiError, type CreateGroupInput, type SendMessageInput } from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import type { AgentMessaging, SteerDispatch } from "@openbot/messaging";
import { Effect } from "effect";
import {
  appendEvent,
  type ComputerFetch,
  hashRequest,
  slugify,
  toError,
  toJson,
} from "./service-utils";
import { serialize } from "./view-mappers";

export class ChannelService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch
  ) {}

  sendDirectMessage = (conversationId: string, input: SendMessageInput) =>
    Effect.tryPromise({
      try: async () => {
        const scope = `conversation:${conversationId}:message`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(
              409,
              "idempotency_conflict",
              "The idempotency key was already used for different content"
            );
          }
          if (existing.response) return serialize(existing.response);
          throw new ApiError(409, "request_in_progress", "This message is already being accepted");
        }

        const accepted = await this.prisma.$transaction(async (tx) => {
          const conversation = await tx.conversation.findUnique({
            where: { id: conversationId },
            include: { bot: true },
          });
          if (!conversation || !["active", "provisioning"].includes(conversation.bot.status)) {
            throw new ApiError(404, "conversation_not_found", "Runnable conversation not found");
          }
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
            },
          });
          const channel = await tx.channel.findUnique({
            where: { directKey: `bot:${conversation.botId}` },
          });
          if (!channel || channel.archivedAt) {
            throw new ApiError(409, "channel_unavailable", "Bot DM channel is unavailable");
          }
          const bootstrapRunId = await this.messaging.skipBootstrapForUser(tx, conversation.botId);
          const visibleMessage = await tx.channelMessage.create({
            data: {
              channelId: channel.id,
              clientId: input.clientId,
              sender: "user",
              content: input.content,
              metadata: { type: "text", ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
            },
          });
          const delivery = await this.messaging.acceptDirectUserMessage(tx, {
            botId: conversation.botId,
            channelId: channel.id,
            content: `[t${visibleMessage.sequence}u] ${input.content}`,
            clientId: input.clientId,
            occurredAt: visibleMessage.createdAt,
            timeZone: input.timeZone,
          });
          await this.messaging.scheduleTranscriptProjection(tx, [conversation.botId]);
          await tx.channel.update({ where: { id: channel.id }, data: { updatedAt: new Date() } });
          const response = { message: visibleMessage, run: delivery.run };
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(response) },
          });
          return {
            response: serialize(response),
            bootstrapRunId,
            steer: delivery.steer,
            interruptRunId: delivery.interruptRunId,
          };
        });
        if (accepted.bootstrapRunId) await this.cancelSkippedBootstrap(accepted.bootstrapRunId);
        if (accepted.interruptRunId) await this.interruptNonUserRun(accepted.interruptRunId);
        if (accepted.steer) await this.dispatchSteer(accepted.steer);
        return accepted.response;
      },
      catch: toError,
    });

  createGroup = (input: CreateGroupInput) =>
    Effect.tryPromise({
      try: async () => {
        const botIds = [...new Set(input.botIds)];
        if (botIds.length < 2) {
          throw new ApiError(400, "group_members_required", "A group needs at least two bots");
        }
        const channelId = crypto.randomUUID();
        const directory = resolve(
          this.workspaceRoot,
          "projects",
          `${slugify(input.name)}-${channelId.slice(0, 8)}`
        );
        if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) {
          throw new ApiError(400, "invalid_workspace", "Generated project path escaped root");
        }
        const activeBots = await this.prisma.bot.count({
          where: { id: { in: botIds }, status: "active" },
        });
        if (activeBots !== botIds.length) {
          throw new ApiError(400, "invalid_group_members", "Every group member must be active");
        }
        await this.provisionDirectories([directory]);
        const channel = await this.prisma.$transaction(async (tx) => {
          const bots = await tx.bot.findMany({
            where: { id: { in: botIds }, status: "active" },
            select: { id: true },
          });
          if (bots.length !== botIds.length) {
            throw new ApiError(400, "invalid_group_members", "Every group member must be active");
          }
          const created = await tx.channel.create({
            data: {
              id: channelId,
              kind: "group",
              name: input.name.trim(),
              workingDirectory: directory,
              members: { create: botIds.map((botId, ordinal) => ({ botId, ordinal })) },
            },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          await appendEvent(tx, "channel.created", created.id, {
            channelId: created.id,
            kind: created.kind,
            botIds,
            workingDirectory: directory,
          });
          return created;
        });
        return serialize({
          ...channel,
          createdAt: channel.createdAt.toISOString(),
          updatedAt: channel.updatedAt.toISOString(),
        });
      },
      catch: toError,
    });

  sendGroupMessage = (channelId: string, input: SendMessageInput) =>
    Effect.tryPromise({
      try: async () => {
        const scope = `channel:${channelId}:message`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, "idempotency_conflict", "Idempotency key content changed");
          }
          if (existing.response) return serialize(existing.response);
          throw new ApiError(409, "request_in_progress", "This message is already being accepted");
        }
        const response = await this.prisma.$transaction(async (tx) => {
          const channel = await tx.channel.findUnique({
            where: { id: channelId },
            include: { members: true },
          });
          if (!channel || channel.kind !== "group" || channel.archivedAt) {
            throw new ApiError(404, "group_not_found", "Active group not found");
          }
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
            },
          });
          const message = await tx.channelMessage.create({
            data: {
              channelId,
              sender: "user",
              clientId: input.clientId,
              content: input.content,
              metadata: { type: "text", ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
            },
          });
          await this.messaging.scheduleTranscriptProjection(
            tx,
            channel.members.map((member) => member.botId)
          );
          const round = await this.messaging.createGroupRound(tx, channelId, message.id, null);
          await tx.channel.update({ where: { id: channelId }, data: { updatedAt: new Date() } });
          await appendEvent(tx, "channel.message.accepted", message.id, {
            channelId,
            messageId: message.id,
            roundId: round.id,
          });
          const accepted = { message, round };
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(accepted) },
          });
          return accepted;
        });
        await this.messaging.advanceRound(response.round.id);
        return serialize(response);
      },
      catch: toError,
    });

  private async provisionDirectories(paths: string[]) {
    const response = await this.computerFetch("/v1/directories", {
      method: "PUT",
      body: JSON.stringify({ paths }),
    });
    if (!response.ok) throw new ApiError(503, "computer_unavailable", await response.text());
  }

  async interruptNonUserRun(runId: string): Promise<void> {
    const run = await this.prisma.run.findUnique({ where: { id: runId } });
    if (
      !run ||
      run.origin === "user" ||
      !["queued", "running", "waiting_approval"].includes(run.status)
    ) {
      return;
    }
    try {
      const response = await this.computerFetch(`/v1/turns/${runId}/cancel`, { method: "POST" });
      if (!response.ok) return;
      await this.prisma.$transaction(async (tx) => {
        await tx.run.update({ where: { id: runId }, data: { status: "cancelled" } });
        await appendEvent(tx, "run.priority_interrupted", runId, { runId });
      });
    } catch {
      // The priority wake remains durable if the previous turn ended during cancellation.
    }
  }

  private async dispatchSteer(steer: SteerDispatch): Promise<void> {
    let fallbackReason = "active_turn_unavailable";
    try {
      const response = await this.computerFetch(`/v1/turns/${steer.activeRunId}/steer`, {
        method: "POST",
        body: JSON.stringify({
          inboxId: steer.inboxId,
          clientMessageId: steer.clientMessageId,
          content: steer.content,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      fallbackReason = `computer_rejected_${response.status}`;
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message.slice(0, 160) : String(error);
    }
    await this.prisma.$transaction((tx) =>
      this.messaging.promoteSteerToWake(tx, steer.inboxId, fallbackReason)
    );
  }

  private async cancelSkippedBootstrap(runId: string): Promise<void> {
    try {
      const response = await this.computerFetch(`/v1/turns/${runId}/cancel`, { method: "POST" });
      if (!response.ok) return;
      await this.prisma.$transaction((tx) =>
        appendEvent(tx, "bot.bootstrap.cancel_requested", runId, { runId })
      );
    } catch {
      // The durable user wake remains queued; a bootstrap that already ended cannot block it.
    }
  }
}
