import {
  ApiError,
  type BotTranscriptView,
  type BotView,
  type CreateBotInput,
  resolveBotAvatarMark,
  type UpdateBotInput,
} from "@openbot/contracts";
import { COMPUTER_API_PATHS } from "@openbot/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openbot/db";
import {
  appendAgentTimelineEvent,
  type BotFileTarget,
  type AgentDataStore,
  type AgentMessaging,
  buildSafeTranscript,
} from "@openbot/messaging";
import { Effect } from "effect";
import { fromPrisma, type PgBoss } from "pg-boss";
import { appendEvent, type ComputerFetch, hashRequest, toError, toJson } from "./service-utils";
import { type BotWithConversation, toBotView } from "./view-mappers";

export class BotService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore,
    private readonly messaging?: AgentMessaging
  ) {}

  list = (includeHidden = false) =>
    Effect.tryPromise({
      try: async () => {
        const bots = await this.prisma.bot.findMany({
          where: {
            status: { not: "archived" },
            ...(includeHidden ? {} : { hiddenFromSidebar: false }),
            subagentIdentity: { is: null },
          },
          include: {
            conversation: true,
            channelMemberships: { include: { channel: true } },
          },
          orderBy: { createdAt: "asc" },
        });
        return bots.map(toBotView);
      },
      catch: toError,
    });

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
        const directory = this.workspaceRoot;
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
        const store = await this.computerFetch(COMPUTER_API_PATHS.agentStore(bot.id), {
          method: "PUT",
          body: JSON.stringify({ createdAt: bot.createdAt.getTime() }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!store.ok) {
          throw new ApiError(503, "agent_store_unavailable", await store.text());
        }
        return toBotView(bot);
      },
      catch: toError,
    });

  update = (botId: string, input: UpdateBotInput) =>
    Effect.tryPromise({
      try: async () => {
        await this.agentData.reconcileBot(botId);
        const name = input.name?.trim();
        const fileTargets: BotFileTarget[] = [];
        if (
          input.name !== undefined ||
          input.title !== undefined ||
          input.description !== undefined ||
          input.icon !== undefined ||
          input.color !== undefined
        ) {
          fileTargets.push("profile");
        }
        if (input.instructions !== undefined) fileTargets.push("instructions");
        if (input.icon !== undefined || input.color !== undefined) fileTargets.push("avatar");
        if (input.notificationsEnabled !== undefined || input.hiddenFromSidebar !== undefined) {
          fileTargets.push("settings");
        }
        const bot = await this.agentData.mutateBotFiles(botId, fileTargets, async (tx) => {
          const existing = await tx.bot.findUnique({
            where: { id: botId },
            include: { subagentIdentity: { select: { id: true } } },
          });
          if (!existing || existing.subagentIdentity) {
            throw new ApiError(404, "bot_not_found", "Bot not found");
          }
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
          if (existing.name && name && name !== existing.name && this.messaging) {
            await appendAgentTimelineEvent(tx, this.messaging, {
              botId,
              clientId: `profile-name:${crypto.randomUUID()}`,
              event: { type: "name-changed", from: existing.name, to: name },
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
        const projection = await buildSafeTranscript(this.prisma, botId);
        const projected = await this.computerFetch(`/v1/transcripts/${botId}`, {
          method: "PUT",
          body: JSON.stringify(projection),
          signal: AbortSignal.timeout(30_000),
        });
        if (!projected.ok) {
          throw new ApiError(
            503,
            "agent_store_unavailable",
            `Transcript projection failed: ${await projected.text()}`
          );
        }
        const response = await this.computerFetch(`/v1/transcripts/${botId}`, {
          method: "GET",
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new ApiError(
            503,
            "agent_store_unavailable",
            `Transcript store read failed: ${await response.text()}`
          );
        }
        const transcript = (await response.json()) as BotTranscriptView;
        if (
          transcript.botId !== botId ||
          typeof transcript.generatedAt !== "string" ||
          !Array.isArray(transcript.events)
        ) {
          throw new ApiError(503, "agent_store_invalid", "Transcript store returned invalid data");
        }
        return transcript;
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
        const children = await this.prisma.subagent.findMany({
          where: { parentBotId: botId },
          select: { id: true, childBotId: true, currentRunId: true, status: true },
        });
        const activeChildren = children.filter((child) =>
          ["provisioning", "queued", "running"].includes(child.status)
        );
        await Promise.all(
          activeChildren.flatMap((child) =>
            child.currentRunId
              ? [
                  this.computerFetch(COMPUTER_API_PATHS.turnCancel(child.currentRunId), {
                    method: "POST",
                    signal: AbortSignal.timeout(5_000),
                  }).catch(() => undefined),
                ]
              : []
          )
        );
        await Promise.all(
          children.map((child) =>
            this.computerFetch(`/v1/screens/${child.childBotId}`, {
              method: "DELETE",
              signal: AbortSignal.timeout(5_000),
            }).catch(() => undefined)
          )
        );
        const contextSessions = await this.prisma.contextSession.findMany({
          where: { botId: { in: [botId, ...children.map((child) => child.childBotId)] } },
          select: { id: true, runtimeSessionPath: true },
        });
        await Promise.all(
          contextSessions.map((contextSession) =>
            this.computerFetch(`/v1/context-sessions/${contextSession.id}`, {
              method: "DELETE",
              body: JSON.stringify({ sessionPath: contextSession.runtimeSessionPath }),
              signal: AbortSignal.timeout(10_000),
            }).then(async (response) => {
              if (!response.ok) {
                throw new ApiError(503, "context_cleanup_failed", await response.text());
              }
            })
          )
        );
        const screenResponse = await this.computerFetch(`/v1/screens/${botId}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(10_000),
        });
        if (!screenResponse.ok) {
          throw new ApiError(503, "screen_cleanup_failed", await screenResponse.text());
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
          const deletedAt = new Date();
          for (const child of activeChildren) {
            const attempt = child.currentRunId
              ? await tx.subagentAttempt.findUnique({
                  where: { childRunId: child.currentRunId },
                })
              : null;
            await tx.subagent.updateMany({
              where: {
                id: child.id,
                status: { in: ["provisioning", "queued", "running"] },
              },
              data: { status: "stopped", stoppedAt: deletedAt, completedAt: deletedAt },
            });
            if (attempt) {
              await tx.subagentAttempt.updateMany({
                where: {
                  id: attempt.id,
                  status: { in: ["provisioning", "queued", "running"] },
                },
                data: { status: "stopped", stoppedAt: deletedAt, completedAt: deletedAt },
              });
            }
            if (child.currentRunId) {
              await tx.run.updateMany({
                where: {
                  id: child.currentRunId,
                  status: { in: ["queued", "running", "waiting_approval"] },
                },
                data: {
                  status: "cancelled",
                  completedAt: deletedAt,
                  error: {
                    code: "parent_archived",
                    message: "The parent agent was archived",
                  },
                },
              });
              await tx.inboxEvent.updateMany({
                where: {
                  runId: child.currentRunId,
                  status: { in: ["pending", "processing"] },
                },
                data: {
                  status: "completed",
                  completedAt: deletedAt,
                  error: { code: "parent_archived" },
                },
              });
              await tx.approval.updateMany({
                where: { runId: child.currentRunId, status: "pending" },
                data: { status: "expired", resolvedAt: deletedAt },
              });
            }
            await appendEvent(tx, "subagent.stopped", child.id, {
              subagentId: child.id,
              parentBotId: botId,
              runId: child.currentRunId,
              attemptId: attempt?.id,
              parentToolCallId: attempt?.parentToolCallId,
              reason: "parent_archived",
            });
          }
          const childBotIds = children.map((child) => child.childBotId);
          await tx.bot.updateMany({
            where: { id: { in: childBotIds } },
            data: { status: "archived" },
          });
          await tx.channel.updateMany({
            where: { directKey: { in: childBotIds.map((id) => `bot:${id}`) } },
            data: { archivedAt: deletedAt },
          });
          await tx.bot.update({
            where: { id: botId },
            data: { status: "archived", avatarPath: null },
          });
          await tx.routine.updateMany({
            where: { botId, deletedAt: null },
            data: {
              enabled: false,
              nextRunAt: null,
              pausedAt: deletedAt,
              deletedAt,
            },
          });
          await tx.channel.updateMany({
            where: { directKey: `bot:${botId}` },
            data: { archivedAt: deletedAt },
          });
          await appendEvent(tx, "bot.archived", botId, { botId });
        });
        await Promise.all(
          [botId, ...children.map((child) => child.childBotId)].map((id) =>
            this.agentData.deleteAgentFiles(id)
          )
        );
        await this.agentData.repairActiveAgentAfterDeletion(botId);
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
