import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  ApiError,
  type ChannelMessageView,
  type ChannelView,
  type ComputerSteerRequest,
  type CreateGroupInput,
  type ReactToChannelMessageInput,
  type RenameChannelInput,
  type SendMessageInput,
  type SetChannelAvatarInput,
  type SetChannelHiddenInput,
  type SetChannelMembersInput,
  type UpdateChannelProfileInput,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import {
  type AgentDataStore,
  type AgentMessaging,
  type AssetStore,
  GROUP_MAX_MEMBERS,
  PRIORITY,
  parseGroupMentions,
  type SteerDispatch,
} from "@openteam/messaging";
import { Effect } from "effect";
import { dismissMoveOnWidgets } from "./rich-message-service";
import {
  appendEvent,
  type ComputerFetch,
  hashRequest,
  slugify,
  toError,
  toJson,
} from "./service-utils";
import { serialize, toChannelView } from "./view-mappers";

type ReplyTarget = {
  id: string;
  sequence: bigint;
  sender: "user" | "agent" | "system";
  content: string;
  metadata: unknown;
};

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

const channelMessageView = (message: {
  id: string;
  clientId?: string | null;
  sequence: bigint;
  channelId: string;
  sender: string;
  senderBotId: string | null;
  sourceRunId: string | null;
  content: string;
  metadata: unknown;
  createdAt: Date;
}): ChannelMessageView => ({
  id: message.id,
  ...(typeof message.clientId === "string" ? { clientId: message.clientId } : {}),
  sequence: message.sequence.toString(),
  channelId: message.channelId,
  sender: message.sender as ChannelMessageView["sender"],
  senderBotId: message.senderBotId,
  sourceRunId: message.sourceRunId,
  content: message.content,
  metadata: message.metadata,
  createdAt: message.createdAt.toISOString(),
});

const messageAddress = (message: ReplyTarget): string => {
  if (message.sender === "user") return `t${message.sequence}u`;
  const metadata = metadataRecord(message.metadata);
  return typeof metadata.address === "string" ? metadata.address : `t${message.sequence}a0`;
};

export const formatUserPrompt = (sequence: bigint, content: string, reply?: ReplyTarget | null) => {
  if (!reply) return content ? `[t${sequence}u] ${content}` : `[t${sequence}u]`;
  return [
    `[t${sequence}u]`,
    `[In reply to ${messageAddress(reply)}: ${JSON.stringify(reply.content)}]`,
    ...(content ? [content] : []),
  ].join("\n");
};

export const formatDirectMentionContext = (
  content: string,
  peers: readonly { id: string; name: string }[]
): string => {
  const mentionedIds = new Set(parseGroupMentions(content, peers).memberIds);
  const mentioned = peers.filter((peer) => mentionedIds.has(peer.id));
  if (mentioned.length === 0) return content;
  return [
    "[Agents mentioned in this message — you can reach them with SendToAgent using their id:]",
    ...mentioned.map((peer) => `- ${peer.name} (id: ${peer.id})`),
    "",
    content,
  ].join("\n");
};

const reactionQuote = (content: string): string => {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const decodeAvatarPng = (encoded: string): Buffer => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new ApiError(400, "invalid_avatar", "Avatar must be a base64-encoded PNG");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_AVATAR_BYTES ||
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new ApiError(400, "invalid_avatar", "Avatar must be a PNG no larger than 5 MB");
  }
  return bytes;
};

export const formatUserReactionPrompt = (emoji: string, content: string) =>
  `[SAND_HIDDEN_PROMPT][The user reacted ${emoji} to your message: ` +
  `${JSON.stringify(reactionQuote(content))}. You don't need to reply; ` +
  `act on it only if it's useful (e.g. acknowledge, adjust, or continue).][SAND_HIDDEN_PROMPT]`;

const xmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const formatChannelRenamePrompt = (input: { name: string; description: string }): string => {
  const profile = JSON.stringify({ name: input.name, description: input.description });
  const token = Buffer.from(profile, "utf8").toString("base64");
  return [
    `[SAND_HIDDEN_PROMPT][SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:${token}>>`,
    "<agent_profile_update>",
    "Your agent profile changed. This full update is authoritative and supersedes the Agent profile section in the system prompt and every earlier profile update in this conversation.",
    `Current name: ${xmlText(input.name)}`,
    `Current description: ${input.description ? xmlText(input.description) : "(no description)"}`,
    "Use this identity until a future conversation summary folds it into the Agent profile section.",
    "</agent_profile_update>",
    "",
    "[event] Something about this conversation just changed.",
    "This is a system event recorded in your timeline, not the user typing in this app, and possibly something you did yourself.",
    `- Renamed to ${input.name}`,
    "If it is worth acknowledging to the user, reply with SendToUser; otherwise it is fine to stay silent.",
  ].join("\n");
};

export class ChannelService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData?: AgentDataStore,
    private readonly assets?: AssetStore
  ) {}

  messageDeliveryStatus = (channelId: string, clientId: string) =>
    Effect.tryPromise({
      try: async () => {
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
      },
      catch: toError,
    });

  sendDirectMessage = (conversationId: string, input: SendMessageInput) =>
    Effect.tryPromise({
      try: async () => {
        input = await this.normalizeMessageAttachments(input);
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
          const visibleMessage = await tx.channelMessage.create({
            data: {
              channelId: channel.id,
              clientId: input.clientId,
              sender: "user",
              content: input.content,
              metadata: {
                type: "text",
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
              visibleMessage.sequence,
              formatDirectMentionContext(input.content, mentionPeers),
              reply
            ),
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
          if (accepted.bootstrapRunId) await this.cancelSkippedBootstrap(accepted.bootstrapRunId);
          if (accepted.interruptRunId) await this.interruptNonUserRun(accepted.interruptRunId);
          if (accepted.steer) await this.dispatchSteer(accepted.steer);
        });
        return accepted.response;
      },
      catch: toError,
    });

  createGroup = (input: CreateGroupInput) =>
    Effect.tryPromise({
      try: async () => {
        const botIds = [...new Set(input.botIds)];
        if (botIds.length < 1) {
          throw new ApiError(400, "group_members_required", "A group needs at least one bot");
        }
        if (botIds.length > GROUP_MAX_MEMBERS) {
          throw new ApiError(
            400,
            "group_too_large",
            `A group can have at most ${GROUP_MAX_MEMBERS} bots`
          );
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
          where: {
            id: { in: botIds },
            status: "active",
            subagentIdentity: { is: null },
          },
        });
        if (activeBots !== botIds.length) {
          throw new ApiError(400, "invalid_group_members", "Every group member must be active");
        }
        await this.provisionDirectories([directory]);
        const channel = await this.prisma.$transaction(async (tx) => {
          const bots = await tx.bot.findMany({
            where: {
              id: { in: botIds },
              status: "active",
              subagentIdentity: { is: null },
            },
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
              members: {
                create: botIds.map((botId, ordinal) => ({ botId, ordinal })),
              },
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
        if (this.agentData) {
          for (const botId of botIds) await this.agentData.writeGroupFilesForBot(botId);
        }
        return serialize({
          ...channel,
          createdAt: channel.createdAt.toISOString(),
          updatedAt: channel.updatedAt.toISOString(),
        });
      },
      catch: toError,
    });

  listGroups = (includeHidden = false) =>
    Effect.tryPromise({
      try: async (): Promise<ChannelView[]> => {
        const groups = await this.prisma.channel.findMany({
          where: {
            kind: "group",
            archivedAt: null,
            ...(includeHidden ? {} : { hiddenFromSidebar: false }),
          },
          include: { members: { orderBy: { ordinal: "asc" } } },
          orderBy: { updatedAt: "desc" },
        });
        return groups.map(toChannelView);
      },
      catch: toError,
    });

  setGroupHidden = (channelId: string, input: SetChannelHiddenInput) =>
    Effect.tryPromise({
      try: async (): Promise<ChannelView> => {
        const scope = `channel:${channelId}:hidden`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, "idempotency_conflict", "Visibility request content changed");
          }
          if (existing.response) return serialize(existing.response) as unknown as ChannelView;
          throw new ApiError(409, "request_in_progress", "Visibility is already being updated");
        }
        return this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${channelId}`}))`;
          const channel = await tx.channel.findFirst({
            where: { id: channelId, kind: "group", archivedAt: null },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          if (!channel) throw new ApiError(404, "group_not_found", "Active group not found");
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
            },
          });
          const changed = channel.hiddenFromSidebar !== input.hidden;
          const updated = changed
            ? await tx.channel.update({
                where: { id: channelId },
                data: { hiddenFromSidebar: input.hidden },
                include: { members: { orderBy: { ordinal: "asc" } } },
              })
            : channel;
          if (changed) {
            await appendEvent(tx, "channel.sidebar_visibility.updated", channelId, {
              channelId,
              hiddenFromSidebar: input.hidden,
            });
          }
          const view = toChannelView(updated);
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(view) },
          });
          return view;
        });
      },
      catch: toError,
    });

  deleteGroup = (channelId: string) =>
    Effect.tryPromise({
      try: async (): Promise<{ deleted: true; channelId: string }> => {
        const { activeRunIds, memberIds } = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${channelId}`}))`;
          const channel = await tx.channel.findFirst({
            where: { id: channelId, kind: "group", archivedAt: null },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          if (!channel) throw new ApiError(404, "group_not_found", "Active group not found");
          const ids = channel.members.map(({ botId }) => botId);
          const activeRuns = await tx.run.findMany({
            where: {
              channelId,
              status: { in: ["queued", "running", "waiting_approval"] },
            },
            select: { id: true },
          });
          const runIds = activeRuns.map(({ id }) => id);
          if (runIds.length > 0) {
            const completedAt = new Date();
            await tx.run.updateMany({
              where: { id: { in: runIds } },
              data: {
                status: "cancelled",
                completedAt,
                error: {
                  code: "group_deleted",
                  message: "The group conversation was deleted",
                },
              },
            });
            await tx.inboxEvent.updateMany({
              where: { runId: { in: runIds }, status: { in: ["pending", "processing"] } },
              data: {
                status: "completed",
                completedAt,
                error: { code: "group_deleted" },
              },
            });
            await tx.approval.updateMany({
              where: { runId: { in: runIds }, status: "pending" },
              data: { status: "expired", resolvedAt: completedAt },
            });
          }
          await tx.channel.delete({ where: { id: channelId } });
          await appendEvent(tx, "channel.deleted", channelId, {
            channelId,
            kind: "group",
            memberIds: ids,
          });
          return { activeRunIds: runIds, memberIds: ids };
        });
        await Promise.all(
          activeRunIds.map((runId) =>
            this.computerFetch(COMPUTER_API_PATHS.turnCancel(runId), {
              method: "POST",
              signal: AbortSignal.timeout(5_000),
            }).catch(() => undefined)
          )
        );
        if (this.agentData) {
          await this.agentData.deleteAgentFiles(channelId);
          for (const botId of memberIds) await this.agentData.writeGroupFilesForBot(botId);
        }
        return { deleted: true, channelId };
      },
      catch: toError,
    });

  updateGroupProfile = (channelId: string, input: UpdateChannelProfileInput) =>
    Effect.tryPromise({
      try: async () => {
        const name = input.name.replace(/\s+/g, " ").trim();
        const description = input.description.trim();
        if (!name) throw new ApiError(400, "channel_name_required", "A chat name cannot be empty");
        const scope = `channel:${channelId}:profile`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, "idempotency_conflict", "Profile request content changed");
          }
          if (!existing.response) {
            throw new ApiError(409, "request_in_progress", "This profile is already being updated");
          }
          return serialize((existing.response as { channel?: unknown }).channel);
        }
        const result = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${channelId}`}))`;
          const channel = await tx.channel.findFirst({
            where: { id: channelId, kind: "group", archivedAt: null },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          if (!channel) throw new ApiError(404, "group_not_found", "Active group not found");
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
            },
          });
          const changed = channel.name !== name || channel.description !== description;
          const updated = changed
            ? await tx.channel.update({
                where: { id: channelId },
                data: { name, description, updatedAt: new Date() },
                include: { members: { orderBy: { ordinal: "asc" } } },
              })
            : channel;
          if (changed) {
            await appendEvent(tx, "channel.profile.updated", channelId, {
              channelId,
              from: { name: channel.name, description: channel.description },
              to: { name, description },
            });
          }
          const response = {
            channel: toChannelView(updated),
            memberIds: updated.members.map(({ botId }) => botId),
            changed,
          };
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(response) },
          });
          return response;
        });
        if (result.changed && this.agentData) {
          for (const botId of result.memberIds) await this.agentData.writeGroupFilesForBot(botId);
        }
        return result.channel;
      },
      catch: toError,
    });

  setGroupAvatar = (channelId: string, input: SetChannelAvatarInput) =>
    Effect.tryPromise({
      try: async (): Promise<ChannelView> => {
        if (!this.agentData)
          throw new ApiError(503, "agent_data_unavailable", "Agent data unavailable");
        const bytes = input.pngBase64 === null ? null : decodeAvatarPng(input.pngBase64);
        const scope = `channel:${channelId}:avatar`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, "idempotency_conflict", "Avatar request content changed");
          }
          if (!existing.response) {
            throw new ApiError(409, "request_in_progress", "This avatar is already being updated");
          }
          return serialize(existing.response) as unknown as ChannelView;
        }
        const channel = await this.prisma.channel.findFirst({
          where: { id: channelId, kind: "group", archivedAt: null },
        });
        if (!channel) throw new ApiError(404, "group_not_found", "Active group not found");
        const directory = this.agentData.botDirectory(channelId);
        await mkdir(directory, { recursive: true, mode: 0o755 });
        const existingAvatarNames = (await readdir(directory).catch(() => [] as string[])).filter(
          (name) => /^avatar\.(?:png|jpg|jpeg|webp|gif|svg)$/i.test(name)
        );
        let avatarPath: string | null = null;
        if (bytes) {
          avatarPath = join(directory, "avatar.png");
          const temporary = join(directory, `.avatar-${input.clientId}.tmp`);
          await writeFile(temporary, bytes, { mode: 0o644 });
          await rename(temporary, avatarPath);
        }
        await Promise.all(
          existingAvatarNames
            .filter((name) => !bytes || name.toLowerCase() !== "avatar.png")
            .map((name) => rm(join(directory, name), { force: true }))
        );
        return this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${channelId}`}))`;
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
            },
          });
          const updated = await tx.channel.update({
            where: { id: channelId },
            data: { avatarPath, updatedAt: new Date() },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          await appendEvent(tx, "channel.avatar.updated", channelId, {
            channelId,
            hasAvatar: Boolean(avatarPath),
          });
          const view = toChannelView(updated);
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(view) },
          });
          return view;
        });
      },
      catch: toError,
    });

  groupAvatar = (channelId: string) =>
    Effect.tryPromise({
      try: async () => {
        if (!this.agentData)
          throw new ApiError(404, "avatar_not_found", "Group avatar unavailable");
        const channel = await this.prisma.channel.findFirst({
          where: { id: channelId, kind: "group", archivedAt: null },
          select: { avatarPath: true },
        });
        if (!channel?.avatarPath)
          throw new ApiError(404, "avatar_not_found", "Group has no avatar");
        const path = await realpath(channel.avatarPath).catch(() => null);
        const expectedRoot = await realpath(this.agentData.botDirectory(channelId)).catch(
          () => null
        );
        const difference = path && expectedRoot ? relative(expectedRoot, path) : "..";
        if (
          !path ||
          difference === "" ||
          difference === ".." ||
          difference.startsWith(`..${sep}`) ||
          extname(path).toLowerCase() !== ".png"
        ) {
          throw new ApiError(404, "avatar_not_found", "Group avatar is unavailable");
        }
        const before = await lstat(path).catch(() => null);
        if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_AVATAR_BYTES) {
          throw new ApiError(404, "avatar_not_found", "Group avatar is unavailable");
        }
        const bytes = await readFile(path);
        if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new ApiError(404, "avatar_not_found", "Group avatar is unavailable");
        }
        return { bytes, contentType: "image/png" };
      },
      catch: toError,
    });

  renameDirectChannel = (channelId: string, input: RenameChannelInput) =>
    Effect.tryPromise({
      try: async () => {
        const requestedName = input.name.replace(/\s+/g, " ").trim();
        if (!requestedName) {
          throw new ApiError(400, "channel_name_required", "A chat name cannot be empty");
        }
        const scope = `channel:${channelId}:rename`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, "idempotency_conflict", "Rename idempotency key changed");
          }
          if (!existing.response) {
            throw new ApiError(409, "request_in_progress", "This chat is already being renamed");
          }
          const replay = existing.response as {
            botId?: unknown;
            bootstrapRunId?: unknown;
            changed?: unknown;
            channel?: unknown;
          };
          if (replay.changed === true && typeof replay.botId === "string") {
            await this.agentData?.writeBotFiles(replay.botId, ["profile"]);
          }
          if (typeof replay.bootstrapRunId === "string") {
            await this.cancelSkippedBootstrap(replay.bootstrapRunId);
          }
          return serialize(replay.channel);
        }

        const target = await this.prisma.channel.findUnique({
          where: { id: channelId },
          select: {
            kind: true,
            archivedAt: true,
            members: { orderBy: { ordinal: "asc" }, select: { botId: true } },
          },
        });
        const targetBotId = target?.members[0]?.botId;
        if (!target || target.archivedAt || target.kind !== "bot_dm" || !targetBotId) {
          throw new ApiError(404, "channel_not_found", "Renameable direct chat not found");
        }
        await this.agentData?.reconcileBot(targetBotId);

        const result = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${channelId}`}))`;
          const channel = await tx.channel.findUnique({
            where: { id: channelId },
            include: {
              members: {
                orderBy: { ordinal: "asc" },
                include: { bot: { include: { subagentIdentity: { select: { id: true } } } } },
              },
            },
          });
          const member = channel?.members[0];
          if (
            !channel ||
            channel.archivedAt ||
            channel.kind !== "bot_dm" ||
            !member ||
            member.bot.subagentIdentity ||
            !["active", "provisioning"].includes(member.bot.status)
          ) {
            throw new ApiError(404, "channel_not_found", "Renameable direct chat not found");
          }

          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
            },
          });

          const from = channel.name;
          const changed = from !== requestedName;
          let bootstrapRunId: string | null = null;
          if (changed) {
            const occurredAt = new Date();
            await tx.bot.update({
              where: { id: member.botId },
              data: { name: requestedName, namedBy: "user" },
            });
            const renamed = await tx.channel.update({
              where: { id: channel.id },
              data: { name: requestedName, updatedAt: occurredAt },
              include: { members: { orderBy: { ordinal: "asc" } } },
            });
            await tx.agentPromptSnapshot.updateMany({
              where: { botId: member.botId },
              data: {
                announcedName: requestedName,
                announcedDescription: member.bot.description,
              },
            });
            await tx.channelMessage.create({
              data: {
                channelId: channel.id,
                clientId: `rename-event:${input.clientId}`,
                sender: "system",
                metadata: {
                  type: "event",
                  event: { type: "name-changed", from, to: requestedName },
                },
                createdAt: occurredAt,
              },
            });
            bootstrapRunId = await this.messaging.skipBootstrapForUser(tx, member.botId);
            await this.messaging.enqueueWake(tx, {
              botId: member.botId,
              channelId: channel.id,
              origin: "user",
              type: "channel.name_changed",
              content: formatChannelRenamePrompt({
                name: requestedName,
                description: member.bot.description,
              }),
              clientId: `rename:${channel.id}:${input.clientId}`,
              priority: PRIORITY.user,
              availableAt: new Date(occurredAt.getTime() + 750),
              occurredAt,
              timeZone: input.timeZone,
              wrapUserContent: false,
            });
            await this.messaging.scheduleTranscriptProjection(tx, [member.botId]);
            await appendEvent(tx, "channel.renamed", channel.id, {
              channelId: channel.id,
              botId: member.botId,
              from,
              to: requestedName,
            });
            await appendEvent(tx, "bot.updated", member.botId, {
              botId: member.botId,
              profileChanged: true,
              settingsChanged: false,
              source: "channel.rename",
            });
            const response = {
              botId: member.botId,
              bootstrapRunId,
              changed,
              channel: renamed,
            };
            await tx.idempotencyRecord.update({
              where: { scope_key: { scope, key: input.clientId } },
              data: { status: "completed", response: toJson(response) },
            });
            return response;
          }

          const unchanged = await tx.channel.findUniqueOrThrow({
            where: { id: channel.id },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          const response = {
            botId: member.botId,
            bootstrapRunId,
            changed,
            channel: unchanged,
          };
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(response) },
          });
          return response;
        });

        if (result.changed) await this.agentData?.writeBotFiles(result.botId, ["profile"]);
        if (result.bootstrapRunId) await this.cancelSkippedBootstrap(result.bootstrapRunId);
        return serialize(result.channel);
      },
      catch: toError,
    });

  setGroupMembers = (channelId: string, input: SetChannelMembersInput) =>
    Effect.tryPromise({
      try: async () => {
        const botIds = [...new Set(input.botIds)];
        if (botIds.length < 1 || botIds.length > GROUP_MAX_MEMBERS) {
          throw new ApiError(
            400,
            "invalid_group_size",
            `A group needs one to ${GROUP_MAX_MEMBERS} bots`
          );
        }
        const scope = `channel:${channelId}:members`;
        const requestHash = hashRequest(input);
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientId } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, "idempotency_conflict", "Membership request content changed");
          }
          if (existing.response) return serialize(existing.response);
          throw new ApiError(409, "request_in_progress", "Membership is already being updated");
        }
        const result = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${channelId}`}))`;
          const channel = await tx.channel.findFirst({
            where: { id: channelId, kind: "group", archivedAt: null },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          if (!channel) throw new ApiError(404, "group_not_found", "Active group not found");
          const activeBots = await tx.bot.findMany({
            where: {
              id: { in: botIds },
              status: "active",
              subagentIdentity: { is: null },
            },
            select: { id: true },
          });
          if (activeBots.length !== botIds.length) {
            throw new ApiError(400, "invalid_group_members", "Every group member must be active");
          }
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key: input.clientId,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
            },
          });
          const previous = channel.members.map((member) => member.botId);
          await tx.channelMember.deleteMany({ where: { channelId } });
          await tx.channelMember.createMany({
            data: botIds.map((botId, ordinal) => ({ channelId, botId, ordinal })),
          });
          const updated = await tx.channel.update({
            where: { id: channelId },
            data: { updatedAt: new Date() },
            include: { members: { orderBy: { ordinal: "asc" } } },
          });
          await appendEvent(tx, "channel.members.updated", channelId, {
            channelId,
            previousMemberIds: previous,
            memberIds: botIds,
          });
          await this.messaging.scheduleTranscriptProjection(tx, [
            ...new Set([...previous, ...botIds]),
          ]);
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(updated) },
          });
          return {
            updated,
            affectedBotIds: [...new Set([...previous, ...botIds])],
          };
        });
        if (this.agentData) {
          for (const botId of result.affectedBotIds) {
            await this.agentData.writeGroupFilesForBot(botId);
          }
        }
        return serialize(result.updated);
      },
      catch: toError,
    });

  sendGroupMessage = (channelId: string, input: SendMessageInput) =>
    Effect.tryPromise({
      try: async () => {
        input = await this.normalizeMessageAttachments(input);
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
          const message = await tx.channelMessage.create({
            data: {
              channelId,
              sender: "user",
              clientId: input.clientId,
              content: input.content,
              metadata: {
                type: "text",
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
        this.afterDurableAcceptance("group message round advancement", () =>
          this.messaging.advanceRound(response.round.id)
        );
        return serialize(response);
      },
      catch: toError,
    });

  reactToMessage = (messageId: string, input: ReactToChannelMessageInput) =>
    Effect.tryPromise({
      try: async () => {
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

  private async cancelSkippedBootstrap(runId: string): Promise<void> {
    try {
      const response = await this.computerFetch(COMPUTER_API_PATHS.turnCancel(runId), {
        method: "POST",
      });
      if (!response.ok) return;
      await this.prisma.$transaction((tx) =>
        appendEvent(tx, "bot.bootstrap.cancel_requested", runId, { runId })
      );
    } catch {
      // The durable user wake remains queued; a bootstrap that already ended cannot block it.
    }
  }
}
