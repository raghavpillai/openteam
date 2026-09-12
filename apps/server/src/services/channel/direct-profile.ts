import { ApiError, type RenameChannelInput } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { type AgentDataStore, type AgentMessaging, PRIORITY } from "@openteam/messaging";
import {
  appendEvent,
  type ComputerFetch,
  hashRequest,
  serviceEffect,
  toJson,
} from "../service-utils";
import { serialize } from "../view-mappers";
import { cancelSkippedBootstrap } from "./delivery";
import { formatChannelRenamePrompt } from "./formatting";

export const renameDirectChannel = (
  prisma: PrismaClient,
  agentData: AgentDataStore | undefined,
  computerFetch: ComputerFetch,
  messaging: AgentMessaging,
  channelId: string,
  input: RenameChannelInput
) =>
  serviceEffect(async () => {
    const requestedName = input.name.replace(/\s+/g, " ").trim();
    if (!requestedName) {
      throw new ApiError(400, "channel_name_required", "A chat name cannot be empty");
    }
    const scope = `channel:${channelId}:rename`;
    const requestHash = hashRequest(input);
    const existing = await prisma.idempotencyRecord.findUnique({
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
        await agentData?.writeBotFiles(replay.botId, ["profile"]);
      }
      if (typeof replay.bootstrapRunId === "string") {
        await cancelSkippedBootstrap(computerFetch, prisma, replay.bootstrapRunId);
      }
      return serialize(replay.channel);
    }

    const target = await prisma.channel.findUnique({
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
    await agentData?.reconcileBot(targetBotId);

    const result = await prisma.$transaction(async (tx) => {
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
        bootstrapRunId = await messaging.skipBootstrapForUser(tx, member.botId);
        await messaging.enqueueWake(tx, {
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
        await messaging.scheduleTranscriptProjection(tx, [member.botId]);
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

    if (result.changed) await agentData?.writeBotFiles(result.botId, ["profile"]);
    if (result.bootstrapRunId)
      await cancelSkippedBootstrap(computerFetch, prisma, result.bootstrapRunId);
    return serialize(result.channel);
  });
