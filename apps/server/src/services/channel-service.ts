import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import {
  ApiError,
  type ChannelView,
  type CreateGroupInput,
  type ReactToChannelMessageInput,
  type RenameChannelInput,
  type SendMessageInput,
  type SetChannelAvatarInput,
  type SetChannelMembersInput,
  type UpdateChannelProfileInput,
} from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import {
  appendAgentTimelineEvent,
  type AgentDataStore,
  type AgentMessaging,
  type AssetStore,
  GROUP_MAX_MEMBERS,
  PRIORITY,
  buildTimelineEventWakePrompt,
  parseGroupMentions,
  renderAgentProfileUpdate,
  type SteerDispatch,
} from "@openbot/messaging";
import { Effect } from "effect";
import { appendEvent, type ComputerFetch, hashRequest, toError, toJson } from "./service-utils";
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

export const formatChannelRenamePrompt = (input: { name: string; description: string }): string => {
  return [
    renderAgentProfileUpdate(input.name, input.description),
    buildTimelineEventWakePrompt({ type: "name-changed", from: "", to: input.name }),
  ].join("\n");
};

export class ChannelService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore,
    private readonly assets: AssetStore
  ) {}

  sendDirectMessage = (conversationId: string, input: SendMessageInput) =>
    Effect.tryPromise({
      try: async () => {
        input = {
          ...input,
          attachments: await this.assets.normalizeRefs(input.attachments ?? []),
        };
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
        const directory = this.workspaceRoot;
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
        const store = await this.computerFetch(`/v1/agent-stores/${channel.id}`, {
          method: "PUT",
          body: JSON.stringify({ createdAt: channel.createdAt.getTime() }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!store.ok) {
          throw new ApiError(503, "group_store_unavailable", await store.text());
        }
        return toChannelView(channel);
      },
      catch: toError,
    });

  updateGroupProfile = (channelId: string, input: UpdateChannelProfileInput) =>
    Effect.tryPromise({
      try: async () => {
        const name = input.name.replace(/\s+/g, " ").trim();
        const description = input.description.trim();
        if (!name) {
          throw new ApiError(400, "channel_name_required", "A chat name cannot be empty");
        }
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
          const replay = existing.response as { channel?: unknown };
          return serialize(replay.channel);
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
          const nameChanged = channel.name !== name;
          const changed = nameChanged || channel.description !== description;
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
      try: async () => {
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
          include: { members: { orderBy: { ordinal: "asc" } } },
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

        const result = await this.prisma.$transaction(async (tx) => {
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
        return result;
      },
      catch: toError,
    });

  groupAvatar = (channelId: string) =>
    Effect.tryPromise({
      try: async () => {
        const channel = await this.prisma.channel.findFirst({
          where: { id: channelId, kind: "group", archivedAt: null },
          select: { avatarPath: true },
        });
        if (!channel?.avatarPath) {
          throw new ApiError(404, "avatar_not_found", "Group has no avatar");
        }
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

        const result = await this.agentData.mutateBotFiles(targetBotId, ["profile"], async (tx) => {
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
            await appendAgentTimelineEvent(tx, this.messaging, {
              botId: member.botId,
              clientId: `rename:${input.clientId}`,
              event: { type: "name-changed", from, to: requestedName },
              occurredAt,
              timeZone: input.timeZone,
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
              channel: toChannelView(renamed),
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
            channel: toChannelView(unchanged),
          };
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.clientId } },
            data: { status: "completed", response: toJson(response) },
          });
          return response;
        });

        if (result.bootstrapRunId) await this.cancelSkippedBootstrap(result.bootstrapRunId);
        return result.channel;
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
            data: { status: "completed", response: toJson(toChannelView(updated)) },
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
        return toChannelView(result.updated);
      },
      catch: toError,
    });

  sendGroupMessage = (channelId: string, input: SendMessageInput) =>
    Effect.tryPromise({
      try: async () => {
        input = {
          ...input,
          attachments: await this.assets.normalizeRefs(input.attachments ?? []),
        };
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
        await this.messaging.advanceRound(response.round.id);
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
          if (existing.response) return serialize(existing.response);
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
          await tx.channelMessage.update({
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
              origin: "handoff_resume",
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
          return result;
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
      const response = await this.computerFetch(`/v1/turns/${runId}/cancel`, {
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

  private async dispatchSteer(steer: SteerDispatch): Promise<void> {
    let fallbackReason = "active_turn_unavailable";
    try {
      const response = await this.computerFetch(`/v1/turns/${steer.activeRunId}/steer`, {
        method: "POST",
        body: JSON.stringify({
          inboxId: steer.inboxId,
          clientMessageId: steer.clientMessageId,
          content: steer.content,
          images: steer.images,
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
      const response = await this.computerFetch(`/v1/turns/${runId}/cancel`, {
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
