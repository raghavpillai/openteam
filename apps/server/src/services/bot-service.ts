import { resolve, sep } from "node:path";
import {
  ApiError,
  type BotTranscriptView,
  type BotView,
  type CreateBotInput,
  resolveBotAvatarMark,
  type UpdateBotInput,
} from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { type AgentDataStore, buildSafeTranscript } from "@openbot/messaging";
import { Effect } from "effect";
import { fromPrisma, type PgBoss } from "pg-boss";
import {
  appendEvent,
  type ComputerFetch,
  hashRequest,
  slugify,
  toError,
  toJson,
} from "./service-utils";
import { type BotWithConversation, toBotView } from "./view-mappers";

export class BotService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore
  ) {}

  create = (input: CreateBotInput) =>
    Effect.tryPromise({
      try: async () => {
        const scope = "bot:create";
        const requestHash = hashRequest(input);
        const previous = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: input.clientRequestId } },
        });
        if (previous) return this.replayCreation(previous, requestHash);

        const botId = crypto.randomUUID();
        const conversationId = crypto.randomUUID();
        const dmChannelId = crypto.randomUUID();
        const name = input.name?.trim() || "New Bot";
        const avatar = resolveBotAvatarMark({
          agentId: botId,
          avatarShape: input.icon,
          avatarColor: input.color,
        });
        const directory = resolve(
          this.workspaceRoot,
          "bots",
          `${slugify(name)}-${botId.slice(0, 8)}`
        );
        if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) {
          throw new ApiError(400, "invalid_workspace", "Generated workspace path escaped root");
        }
        let bot: BotWithConversation;
        try {
          bot = await this.prisma.$transaction(async (tx) => {
            await tx.idempotencyRecord.create({
              data: {
                scope,
                key: input.clientRequestId,
                requestHash,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
              },
            });
            await tx.bot.create({
              data: {
                id: botId,
                name,
                title: input.title?.trim() ?? "",
                description: input.description?.trim() ?? "",
                instructions: input.instructions?.trim() ?? "",
                icon: avatar.shape,
                color: avatar.color,
                namedBy: input.name?.trim() ? "user" : "app",
                notificationsEnabled: input.notificationsEnabled ?? true,
                defaultDirectory: directory,
                status: "provisioning",
                onboardingStatus: "pending",
                conversation: { create: { id: conversationId } },
              },
            });
            await tx.channel.create({
              data: {
                id: dmChannelId,
                kind: "bot_dm",
                name,
                directKey: `bot:${botId}`,
                members: { create: { botId, ordinal: 0 } },
              },
            });
            await appendEvent(tx, "bot.created", botId, {
              botId,
              conversationId,
              dmChannelId,
            });
            await this.boss.send(
              "bot-provision",
              { botId },
              {
                db: fromPrisma(tx),
                retryLimit: 8,
                retryDelay: 2,
                retryBackoff: true,
                expireInSeconds: 3 * 60,
              }
            );
            await tx.idempotencyRecord.update({
              where: { scope_key: { scope, key: input.clientRequestId } },
              data: { status: "completed", response: toJson({ botId }) },
            });
            return tx.bot.findUniqueOrThrow({
              where: { id: botId },
              include: {
                conversation: true,
                channelMemberships: { include: { channel: true } },
              },
            });
          });
        } catch (error) {
          if ((error as { code?: string }).code !== "P2002") throw error;
          const winner = await this.prisma.idempotencyRecord.findUniqueOrThrow({
            where: { scope_key: { scope, key: input.clientRequestId } },
          });
          return this.replayCreation(winner, requestHash);
        }
        if (!bot.conversation)
          throw new ApiError(500, "bot_incomplete", "Bot conversation is missing");
        await this.agentData.projectBot(bot.id);
        return toBotView(bot);
      },
      catch: toError,
    });

  update = (botId: string, input: UpdateBotInput) =>
    Effect.tryPromise({
      try: async () => {
        await this.agentData.reconcileBot(botId);
        const existing = await this.prisma.bot.findUnique({
          where: { id: botId },
          include: { subagentIdentity: { select: { id: true } } },
        });
        if (!existing || existing.subagentIdentity) {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        const name = input.name?.trim();
        const bot = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.bot.update({
            where: { id: botId },
            data: {
              name,
              title: input.title?.trim(),
              description: input.description?.trim(),
              instructions: input.instructions?.trim(),
              icon: input.icon,
              color: input.color,
              avatarPath: input.icon !== undefined || input.color !== undefined ? null : undefined,
              notificationsEnabled: input.notificationsEnabled,
              hiddenFromSidebar: input.hiddenFromSidebar,
            },
            include: {
              conversation: true,
              channelMemberships: { include: { channel: true } },
            },
          });
          if (name) {
            await tx.channel.updateMany({
              where: { directKey: `bot:${botId}` },
              data: { name },
            });
          }
          await appendEvent(tx, "bot.updated", botId, {
            botId,
            profileChanged:
              input.name !== undefined ||
              input.title !== undefined ||
              input.description !== undefined ||
              input.instructions !== undefined,
            settingsChanged:
              input.notificationsEnabled !== undefined || input.hiddenFromSidebar !== undefined,
          });
          return updated;
        });
        if (!bot.conversation)
          throw new ApiError(500, "bot_incomplete", "Bot conversation is missing");
        await this.agentData.writeBotFiles(bot.id);
        return toBotView(bot);
      },
      catch: toError,
    });

  retryProvisioning = (botId: string) =>
    Effect.tryPromise({
      try: async () => {
        const bot = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.bot.findUnique({
            where: { id: botId },
            include: { subagentIdentity: { select: { id: true } } },
          });
          if (!existing || existing.status === "archived" || existing.subagentIdentity) {
            throw new ApiError(404, "bot_not_found", "Bot not found");
          }
          if (existing.status !== "active") {
            await tx.bot.update({
              where: { id: botId },
              data: {
                status: "provisioning",
                provisioningError: Prisma.DbNull,
              },
            });
            await this.boss.send(
              "bot-provision",
              { botId },
              {
                db: fromPrisma(tx),
                retryLimit: 8,
                retryDelay: 2,
                retryBackoff: true,
                expireInSeconds: 3 * 60,
              }
            );
            await appendEvent(tx, "bot.provisioning_retried", botId, { botId });
          }
          return tx.bot.findUniqueOrThrow({
            where: { id: botId },
            include: {
              conversation: true,
              channelMemberships: { include: { channel: true } },
            },
          });
        });
        if (!bot.conversation)
          throw new ApiError(500, "bot_incomplete", "Bot conversation is missing");
        return toBotView(bot);
      },
      catch: toError,
    });

  transcript = (botId: string) =>
    Effect.tryPromise({
      try: async (): Promise<BotTranscriptView> => {
        const bot = await this.prisma.bot.findUnique({
          where: { id: botId },
          include: { subagentIdentity: { select: { id: true } } },
        });
        if (!bot || bot.status === "archived" || bot.subagentIdentity) {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        return buildSafeTranscript(this.prisma, botId);
      },
      catch: toError,
    });

  archive = (botId: string) =>
    Effect.tryPromise({
      try: async () => {
        const existing = await this.prisma.bot.findUnique({
          where: { id: botId },
          include: { subagentIdentity: { select: { id: true } } },
        });
        if (!existing || existing.subagentIdentity) {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        const screenResponse = await this.computerFetch(`/v1/screens/${botId}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(10_000),
        });
        if (!screenResponse.ok) {
          throw new ApiError(503, "screen_cleanup_failed", await screenResponse.text());
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.bot.update({
            where: { id: botId },
            data: { status: "archived", avatarPath: null },
          });
          await tx.channel.updateMany({
            where: { directKey: `bot:${botId}` },
            data: { archivedAt: new Date() },
          });
          await appendEvent(tx, "bot.archived", botId, { botId });
        });
        await this.agentData.deleteAgentFiles(botId);
        return { ok: true };
      },
      catch: toError,
    });

  private async replayCreation(
    record: { requestHash: string; response: Prisma.JsonValue | null },
    requestHash: string
  ): Promise<BotView> {
    if (record.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "The creation request id was already used for a different bot"
      );
    }
    const botId =
      record.response &&
      typeof record.response === "object" &&
      !Array.isArray(record.response) &&
      typeof (record.response as Record<string, unknown>).botId === "string"
        ? ((record.response as Record<string, unknown>).botId as string)
        : null;
    if (!botId) throw new ApiError(409, "request_in_progress", "This bot is already being created");
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      include: {
        conversation: true,
        channelMemberships: { include: { channel: true } },
      },
    });
    if (!bot?.conversation) {
      throw new ApiError(500, "bot_incomplete", "Created bot conversation is missing");
    }
    return toBotView(bot);
  }
}
