import { nextMessageAddress, lockGroupExecution, supersedeGroupUserTurns } from "@openteam/messaging";
import {
  ApiError,
  type ComputerSteerRequest,
  type ReactToChannelMessageInput,
  type RenameChannelInput,
  type SendMessageInput,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import {
  type AgentDataStore,
  type AgentMessaging,
  type AssetStore,
  PRIORITY,
  type SteerDispatch,
} from "@openteam/messaging";
import { cancelSkippedBootstrap } from "./channel/delivery";
import { renameDirectChannel } from "./channel/direct-profile";
import {
  formatDirectMentionContext,
  formatUserPrompt,
  formatUserReactionPrompt,
} from "./channel/formatting";
import { GroupAdministration } from "./channel/group-administration";
import { dismissMoveOnWidgets } from "./rich-message-service";
import {
  appendEvent,
  type ComputerFetch,
  forwardServiceMethod,
  hashRequest,
  metadataRecord,
  serviceEffect,
  toJson,
} from "./service-utils";
import { toChannelMessageView as channelMessageView, serialize } from "./view-mappers";

export class ChannelService {
  private readonly groups: GroupAdministration;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData?: AgentDataStore,
    private readonly assets?: AssetStore
  ) {
    this.groups = new GroupAdministration(
      prisma,
      messaging,
      workspaceRoot,
      computerFetch,
      agentData
    );
  }

  messageDeliveryStatus = (channelId: string, clientId: string) =>
    serviceEffect(async () => {
      if (clientId.length < 8 || clientId.length > 120) {
        throw new ApiError(400, "invalid_client_id", "Message delivery ID is invalid");
      }
      const message = await this.prisma.channelMessage.findUnique({
        where: { channelId_clientId: { channelId, clientId } },
      });
      if (message) {
        return {
          clientId,
          status: "accepted" as const,
          acceptedAtMs: message.createdAt.getTime(),
          message: channelMessageView(message),
        };
      }
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        include: {
          members: {
            orderBy: { ordinal: "asc" },
            include: { bot: { include: { conversation: true } } },
          },
        },
      });
      if (!channel) {
        throw new ApiError(404, "channel_not_found", "Channel was not found");
      }
      const conversationId =
        channel.kind === "bot_dm" ? channel.members[0]?.bot.conversation?.id : null;
      const scope = conversationId
        ? `conversation:${conversationId}:message`
        : `channel:${channelId}:message`;
      const idempotency = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key: clientId } },
      });
      if (!idempotency) {
        return { clientId, status: "not_found" as const, acceptedAtMs: null, message: null };
      }
      if (idempotency.status === "processing") {
        return { clientId, status: "pending" as const, acceptedAtMs: null, message: null };
      }
      if (idempotency.status === "failed") {
        return {
          clientId,
          status: "rejected" as const,
          acceptedAtMs: null,
          message: null,
          code: "server_rejected",
          messageText: "The server rejected this message.",
        };
      }
      return {
        clientId,
        status: "unknown_durability" as const,
        acceptedAtMs: null,
        message: null,
      };
    });

  sendDirectMessage = (conversationId: string, input: SendMessageInput) =>
    serviceEffect(async () => {
      input = await this.normalizeMessageAttachments(input);
      const scope = `conversation:${conversationId}:message`;
      // Enrollment can finish between delivery retries. Origin is routing metadata,
      // not a content change; the first accepted message keeps its original origin.
      const requestHash = hashRequest({ ...input, sourceMachineId: undefined });
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
          include: { bot: { include: { subagentIdentity: { select: { id: true } } } } },
        });
        if (
          !conversation ||
          conversation.bot.subagentIdentity ||
          !["active", "provisioning"].includes(conversation.bot.status)
        ) {
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
        const reply = input.replyToMessageId
          ? await tx.channelMessage.findFirst({
              where: { id: input.replyToMessageId, channelId: channel.id },
            })
          : null;
        if (input.replyToMessageId && !reply) {
          throw new ApiError(404, "reply_target_not_found", "Reply target was not found");
        }
        const bootstrapRunId = await this.messaging.skipBootstrapForUser(tx, conversation.botId);
        await dismissMoveOnWidgets(tx, channel.id);
        const mentionPeers = await tx.bot.findMany({
          where: {
            id: { not: conversation.botId },
            status: "active",
            subagentIdentity: { is: null },
          },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        });
        const sourceMachineId = input.sourceMachineId && await tx.hostMachine.findUnique({ where: { machineId: input.sourceMachineId }, select: { machineId: true } }) ? input.sourceMachineId : undefined;
        const address = await nextMessageAddress(tx, channel.id, "user");
        const visibleMessage = await tx.channelMessage.create({
          data: {
            channelId: channel.id,
            clientId: input.clientId,
            sender: "user",
            content: input.content,
            metadata: {
              type: "text",
              address,
              ...(sourceMachineId ? { sourceMachineId } : {}),
              ...(input.attachments?.length ? { attachments: input.attachments } : {}),
              ...(reply ? { replyTo: reply.id } : {}),
              ...(input.richText ? { richText: input.richText } : {}),
              ...(input.isFork ? { branched: true } : {}),
              ...(input.timeZone ? { timeZone: input.timeZone } : {}),
            },
          },
        });
        const delivery = await this.messaging.acceptDirectUserMessage(tx, {
          botId: conversation.botId,
          channelId: channel.id,
          content: formatUserPrompt(
            address,
            formatDirectMentionContext(input.content, mentionPeers),
            reply
          ) + (sourceMachineId ? `\n\n[Sent from machine ${sourceMachineId}]` : ""),
          attachments: input.attachments,
          clientId: input.clientId,
          occurredAt: visibleMessage.createdAt,
          timeZone: input.timeZone,
          ...(input.isFork ? { replyToMessageId: visibleMessage.id, isFork: true } : {}),
        });
        await this.messaging.scheduleTranscriptProjection(tx, [conversation.botId]);
        await tx.channel.update({
          where: { id: channel.id },
          data: { updatedAt: new Date() },
        });
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
      this.afterDurableAcceptance("direct message follow-up", async () => {
        if (accepted.bootstrapRunId)
          await cancelSkippedBootstrap(this.computerFetch, this.prisma, accepted.bootstrapRunId);
        if (accepted.interruptRunId) await this.interruptNonUserRun(accepted.interruptRunId);
        if (accepted.steer) await this.dispatchSteer(accepted.steer);
      });
      return accepted.response;
    });

  createGroup = forwardServiceMethod(() => this.groups.createGroup);

  listGroups = (includeHidden = false) => this.groups.listGroups(includeHidden);

  setGroupHidden = forwardServiceMethod(() => this.groups.setGroupHidden);

  deleteGroup = forwardServiceMethod(() => this.groups.deleteGroup);

  updateGroupProfile = forwardServiceMethod(() => this.groups.updateGroupProfile);

  setGroupAvatar = forwardServiceMethod(() => this.groups.setGroupAvatar);

  groupAvatar = forwardServiceMethod(() => this.groups.groupAvatar);

  renameDirectChannel = (channelId: string, input: RenameChannelInput) =>
    renameDirectChannel(
      this.prisma,
      this.agentData,
      this.computerFetch,
      this.messaging,
      channelId,
      input
    );

  setGroupMembers = forwardServiceMethod(() => this.groups.setGroupMembers);

  sendGroupMessage = (channelId: string, input: SendMessageInput) =>
    serviceEffect(async () => {
      input = await this.normalizeMessageAttachments(input);
      const scope = `channel:${channelId}:message`;
      const requestHash = hashRequest({ ...input, sourceMachineId: undefined });
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
      let supersededRunIds: string[] = [];
      const response = await this.prisma.$transaction(async (tx) => {
        await lockGroupExecution(tx, channelId);
        // Recheck after the room lock: concurrent delivery retries must not
        // create another root or cancel the first accepted request's turn.
        const duplicate = await tx.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (duplicate) {
          if (duplicate.requestHash !== requestHash)
            throw new ApiError(409, "idempotency_conflict", "Idempotency key content changed");
          if (duplicate.response) return duplicate.response as any;
          throw new ApiError(409, "request_in_progress", "This message is already being accepted");
        }
        const channel = await tx.channel.findUnique({
          where: { id: channelId },
          include: { members: true },
        });
        if (!channel || channel.kind !== "group" || channel.archivedAt) {
          throw new ApiError(404, "group_not_found", "Active group not found");
        }
        const reply = input.replyToMessageId
          ? await tx.channelMessage.findFirst({
              where: { id: input.replyToMessageId, channelId },
            })
          : null;
        if (input.replyToMessageId && !reply) {
          throw new ApiError(404, "reply_target_not_found", "Reply target was not found");
        }
        await tx.idempotencyRecord.create({
          data: {
            scope,
            key: input.clientId,
            requestHash,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
          },
        });
        await dismissMoveOnWidgets(tx, channelId);
        const sourceMachineId = input.sourceMachineId && await tx.hostMachine.findUnique({ where: { machineId: input.sourceMachineId }, select: { machineId: true } }) ? input.sourceMachineId : undefined;
        const address = await nextMessageAddress(tx, channelId, "user");
        const message = await tx.channelMessage.create({
          data: {
            channelId,
            sender: "user",
            clientId: input.clientId,
            content: input.content,
            metadata: {
              type: "text",
              address,
              ...(sourceMachineId ? { sourceMachineId } : {}),
              ...(input.attachments?.length ? { attachments: input.attachments } : {}),
              ...(reply ? { replyTo: reply.id } : {}),
              ...(input.richText ? { richText: input.richText } : {}),
              ...(input.isFork ? { branched: true } : {}),
              ...(input.timeZone ? { timeZone: input.timeZone } : {}),
            },
          },
        });
        await this.messaging.scheduleTranscriptProjection(
          tx,
          channel.members.map((member) => member.botId)
        );
        supersededRunIds = await supersedeGroupUserTurns(tx, channelId, message.id);
        const round = await this.messaging.createGroupRound(tx, {
          channelId,
          triggerMessageId: message.id,
          initiatorBotId: null,
        });
        await tx.channel.update({
          where: { id: channelId },
          data: { updatedAt: new Date() },
        });
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
      this.afterDurableAcceptance("group message round advancement", async () => {
        // The durable cancellation fence already prevents stale publication.
        // Stop the runtime too, without holding the acceptance transaction open.
        await Promise.allSettled(supersededRunIds.map((runId) =>
          this.computerFetch(COMPUTER_API_PATHS.turnCancel(runId), { method: "POST" })
        ));
        await this.messaging.advanceRound(response.round.id);
      });
      return serialize(response);
    });

  reactToMessage = (messageId: string, input: ReactToChannelMessageInput) =>
    serviceEffect(async () => {
      const scope = `channel-message:${messageId}:user-reaction`;
      const requestHash = hashRequest(input);
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key: input.clientId } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiError(409, "idempotency_conflict", "Reaction idempotency key changed");
        }
        if (existing.response) {
          const message = await this.prisma.channelMessage.findUnique({
            where: { id: messageId },
          });
          if (!message) throw new ApiError(404, "message_not_found", "Message was not found");
          return {
            ...(serialize(existing.response) as Record<string, unknown>),
            message: channelMessageView(message),
          };
        }
        throw new ApiError(409, "request_in_progress", "This reaction is already being applied");
      }

      const response = await this.prisma.$transaction(async (tx) => {
        const message = await tx.channelMessage.findUnique({
          where: { id: messageId },
          include: {
            channel: { include: { members: { select: { botId: true } } } },
            senderBot: true,
          },
        });
        if (!message || message.channel.archivedAt) {
          throw new ApiError(404, "message_not_found", "Message was not found");
        }
        await tx.idempotencyRecord.create({
          data: {
            scope,
            key: input.clientId,
            requestHash,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
          },
        });

        const metadata = metadataRecord(message.metadata);
        const reactions = Array.isArray(metadata.reactions)
          ? metadata.reactions.filter(
              (reaction): reaction is { by: string; emoji: string } =>
                Boolean(reaction) &&
                typeof reaction === "object" &&
                !Array.isArray(reaction) &&
                typeof (reaction as Record<string, unknown>).by === "string" &&
                typeof (reaction as Record<string, unknown>).emoji === "string"
            )
          : [];
        const removed = reactions.some(
          (reaction) => reaction.by === "me" && reaction.emoji === input.emoji
        );
        const next = reactions.filter(
          (reaction) => !(reaction.by === "me" && reaction.emoji === input.emoji)
        );
        if (!removed) next.push({ by: "me", emoji: input.emoji });
        if (next.length > 0) metadata.reactions = next;
        else delete metadata.reactions;
        const updatedMessage = await tx.channelMessage.update({
          where: { id: message.id },
          data: { metadata: toJson(metadata) },
        });

        let runId: string | null = null;
        if (
          !removed &&
          message.sender === "agent" &&
          message.senderBot &&
          ["active", "provisioning"].includes(message.senderBot.status)
        ) {
          const wake = await this.messaging.enqueueWake(tx, {
            botId: message.senderBot.id,
            channelId: message.channelId,
            origin: "user",
            type: "user.reaction",
            content: formatUserReactionPrompt(input.emoji, message.content),
            clientId: `reaction:${message.id}:${input.clientId}`,
            priority: PRIORITY.user,
            occurredAt: new Date(),
            timeZone: input.timeZone,
          });
          runId = wake.run.id;
        }
        await this.messaging.scheduleTranscriptProjection(
          tx,
          message.channel.members.map((member) => member.botId)
        );

        const result = {
          messageId: message.id,
          emoji: input.emoji,
          reacted: !removed,
          removed,
          runId,
        };
        await appendEvent(tx, "channel.message.user_reaction", message.id, result);
        await tx.idempotencyRecord.update({
          where: { scope_key: { scope, key: input.clientId } },
          data: { status: "completed", response: toJson(result) },
        });
        return { ...result, message: channelMessageView(updatedMessage) };
      });
      return serialize(response);
    });

  private afterDurableAcceptance(label: string, operation: () => Promise<void>): void {
    void operation().catch((cause) => {
      // The accepted message and its inbox/round state are already committed.
      // Startup recovery and queue retry remain authoritative for follow-up work.
      console.error(label, cause);
    });
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
      const response = await this.computerFetch(COMPUTER_API_PATHS.turnCancel(runId), {
        method: "POST",
      });
      if (!response.ok) return;
      await this.prisma.$transaction(async (tx) => {
        const interrupted = await tx.run.updateMany({
          where: {
            id: runId,
            origin: { not: "user" },
            status: { in: ["queued", "running", "waiting_approval"] },
          },
          data: {
            status: "cancelled",
            error: {
              code: "priority_peer_interrupt",
              message: "superseded by a priority agent message",
            },
          },
        });
        if (interrupted.count > 0) {
          await appendEvent(tx, "run.priority_interrupted", runId, { runId });
        }
      });
    } catch {
      // The priority wake remains durable if the previous turn ended during cancellation.
    }
  }

  private async normalizeMessageAttachments(input: SendMessageInput): Promise<SendMessageInput> {
    if (!input.attachments?.length) return input;

    const assets = this.assets ?? this.messaging.assets;
    if (!assets) {
      throw new ApiError(503, "asset_store_unavailable", "Attachments are temporarily unavailable");
    }
    return { ...input, attachments: await assets.normalizeRefs(input.attachments) };
  }

  private async dispatchSteer(steer: SteerDispatch): Promise<void> {
    let fallbackReason = "active_turn_unavailable";
    try {
      const input = {
        inboxId: steer.inboxId,
        clientMessageId: steer.clientMessageId,
        content: steer.content,
        images: steer.images,
      } satisfies ComputerSteerRequest;
      const response = await this.computerFetch(COMPUTER_API_PATHS.turnSteer(steer.activeRunId), {
        method: "POST",
        body: JSON.stringify(input),
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
}

export {
  formatChannelRenamePrompt,
  formatDirectMentionContext,
  formatUserPrompt,
  formatUserReactionPrompt,
} from "./channel/formatting";
