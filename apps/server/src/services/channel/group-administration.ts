import {
  ApiError,
  type ChannelView,
  type CreateGroupInput,
  type SetChannelAvatarInput,
  type SetChannelHiddenInput,
  type SetChannelMembersInput,
  type UpdateChannelProfileInput,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import { type AgentDataStore, type AgentMessaging, GROUP_MAX_MEMBERS } from "@openteam/messaging";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { provisionDirectories } from "../provision-directories";
import {
  appendEvent,
  type ComputerFetch,
  hashRequest,
  serviceEffect,
  toJson,
} from "../service-utils";
import { serialize, toChannelView } from "../view-mappers";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const decodeAvatarPng = (encoded: string): Buffer => {
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

export class GroupAdministration {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData?: AgentDataStore
  ) {}
  createGroup = (input: CreateGroupInput) =>
    serviceEffect(async () => {
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
      // Rooms share the same starting directory as direct turns and subagents.
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
      await provisionDirectories(this.computerFetch, [directory]);
      const channel = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
    });

  listGroups = (includeHidden = false) =>
    serviceEffect(async (): Promise<ChannelView[]> => {
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
    });

  setGroupHidden = (channelId: string, input: SetChannelHiddenInput) =>
    serviceEffect(async (): Promise<ChannelView> => {
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
    });

  deleteGroup = (channelId: string) =>
    serviceEffect(async (): Promise<{ deleted: true; channelId: string }> => {
      const { activeRunIds, memberIds } = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
    });

  updateGroupProfile = (channelId: string, input: UpdateChannelProfileInput) =>
    serviceEffect(async () => {
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
        if (changed && this.agentData) for (const botId of response.memberIds) await this.agentData.writeGroupFilesForBot(botId, tx);
        return response;
      });
      if (result.changed && this.agentData) {
        for (const botId of result.memberIds) await this.agentData.writeGroupFilesForBot(botId);
      }
      return result.channel;
    });

  setGroupAvatar = (channelId: string, input: SetChannelAvatarInput) =>
    serviceEffect(async (): Promise<ChannelView> => {
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
    });

  groupAvatar = (channelId: string) =>
    serviceEffect(async () => {
      if (!this.agentData) throw new ApiError(404, "avatar_not_found", "Group avatar unavailable");
      const channel = await this.prisma.channel.findFirst({
        where: { id: channelId, kind: "group", archivedAt: null },
        select: { avatarPath: true },
      });
      if (!channel?.avatarPath) throw new ApiError(404, "avatar_not_found", "Group has no avatar");
      const path = await realpath(channel.avatarPath).catch(() => null);
      const expectedRoot = await realpath(this.agentData.botDirectory(channelId)).catch(() => null);
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
    });

  setGroupMembers = (channelId: string, input: SetChannelMembersInput) =>
    serviceEffect(async () => {
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
        if (this.agentData) for (const botId of botIds) await this.agentData.writeGroupFilesForBot(botId, tx);
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
    });
}
