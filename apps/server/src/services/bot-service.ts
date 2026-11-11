import {
  ApiError,
  type BotTranscriptView,
  type BotRecipe,
  type BotView,
  type CreateBotInput,
  resolveBotAvatarMark,
  type UpdateBotInput,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openteam/db";
import {
  type AgentDataStore,
  type AgentMessaging,
  appendAgentTimelineEvent,
  stopRequestProgress,
  lockAgentLifecycle,
  cleanupRetiredAgent,
  type BotFileTarget,
  buildSafeTranscript,
} from "@openteam/messaging";
import { fromPrisma, type PgBoss } from "pg-boss";
import {
  appendEvent,
  type ComputerFetch,
  hashRequest,
  serviceEffect,
  toJson,
} from "./service-utils";
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

  list = (_includeHidden = false) =>
    serviceEffect(async () => {
      const bots = await this.prisma.bot.findMany({
        where: {
          status: { not: "archived" },
          subagentIdentity: { is: null },
        },
        include: {
          conversation: true,
          channelMemberships: { include: { channel: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return bots.map(toBotView);
    });

  // Legacy template and agent-administration callers still carry durable guidance.
  // HTTP profile schemas deliberately omit this retired editor field.
  create = (input: CreateBotInput & { instructions?: string }, recipe?: BotRecipe) =>
    serviceEffect(async () => {
      const scope = "bot:create";
      const requestHash = hashRequest(recipe ? { ...input, recipe } : input);
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
              templateRecipe: recipe ? toJson(recipe) : undefined,
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
    });

  update = (botId: string, input: UpdateBotInput & { instructions?: string }) =>
    serviceEffect(async () => {
      const name = input.name?.trim();
      if (name === "") throw new ApiError(400, "invalid_bot_name", "Bot name must not be blank");
      await this.agentData.reconcileBot(botId);
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
      if (input.icon !== undefined || input.color !== undefined) fileTargets.push("avatar");
      if (input.notificationsEnabled !== undefined) {
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
            draftingDisabled: input.draftingDisabled,
            draftAllowedRecipients: input.draftAllowedRecipients
              ? [...new Set(input.draftAllowedRecipients.map((address) => address.trim().toLowerCase()))]
              : undefined,
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
            input.notificationsEnabled !== undefined ||
            input.draftingDisabled !== undefined ||
            input.draftAllowedRecipients !== undefined,
        });
        return updated;
      });
      if (!bot.conversation)
        throw new ApiError(500, "bot_incomplete", "Bot conversation is missing");
      return toBotView(bot);
    });

  retryProvisioning = (botId: string) =>
    serviceEffect(async () => {
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
    });

  transcript = (botId: string) =>
    serviceEffect(async (): Promise<BotTranscriptView> => {
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
    });

  archive = (botId: string) =>
    serviceEffect(async () => {
      const ownerIds = await this.prisma.$transaction(async (tx) => {
        await lockAgentLifecycle(tx, botId);
        const existing = await tx.bot.findUnique({
          where: { id: botId },
          include: { subagentIdentity: { select: { id: true } } },
        });
        if (!existing || existing.subagentIdentity) {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        const children = await tx.subagent.findMany({
          where: { parentBotId: botId },
          select: { id: true, childBotId: true, currentRunId: true, status: true },
        });
        const activeChildren = children.filter((child) =>
          ["provisioning", "queued", "running", "waiting"].includes(child.status)
        );
        const ownerIds = [botId, ...children.map((child) => child.childBotId)];
        await stopRequestProgress(tx, botId);
        // stopRequestProgress holds the parent's claim lock. Fence each child's snapshot too,
        // before changing its run/inbox rows, so a delayed claim cannot revive cancelled work
        // or recreate contexts after runtime cleanup has finished.
        for (const childBotId of children.map((child) => child.childBotId).sort()) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-run-claim:${childBotId}`}))`;
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
        const deletedAt = new Date();
        // Persist cancellation before contacting the runtime. The worker heartbeat retries it if
        // the computer is temporarily unavailable, and archived bots cannot claim another wake.
        const activeRuns = await tx.run.findMany({
          where: { botId: { in: ownerIds }, status: { in: ["queued", "running"] } },
          select: { id: true, botId: true },
        });
        for (const child of activeChildren) {
          const attempt = child.currentRunId
            ? await tx.subagentAttempt.findUnique({
                where: { childRunId: child.currentRunId },
              })
            : null;
          await tx.subagent.updateMany({
            where: {
              id: child.id,
              status: { in: ["provisioning", "queued", "running", "waiting"] },
            },
            data: { status: "stopped", stoppedAt: deletedAt, completedAt: deletedAt, nextCheckAt: null },
          });
          if (attempt) {
            await tx.subagentAttempt.updateMany({
              where: {
                id: attempt.id,
                status: { in: ["provisioning", "queued", "running", "waiting"] },
              },
              data: { status: "stopped", stoppedAt: deletedAt, completedAt: deletedAt },
            });
          }
          if (child.currentRunId) {
            await tx.run.updateMany({
              where: {
                id: child.currentRunId,
                status: { in: ["queued", "running"] },
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
        await tx.run.updateMany({
          where: { botId: { in: ownerIds }, status: { in: ["queued", "running"] } },
          data: { status: "cancelled", completedAt: deletedAt,
            error: { code: "bot_archived", message: "The agent was archived" } },
        });
        await tx.inboxEvent.updateMany({
          where: { botId: { in: ownerIds }, status: { in: ["pending", "processing"] } },
          data: { status: "completed", completedAt: deletedAt, error: { code: "bot_archived" } },
        });
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
        for (const id of ownerIds) {
          const cleanupRunIds = activeRuns.filter((run) => run.botId === id).map(({ id }) => id);
          await tx.retiredAgent.upsert({
            where: { id },
            create: { id, cleanupRunIds },
            // Repeated deletion must not erase a cancellation that still needs delivery.
            update: { cleanupPending: true, nextCleanupAt: deletedAt, cleanupRunIds: { push: cleanupRunIds } },
          });
        }
        await appendEvent(tx, "bot.archived", botId, { botId });
        return ownerIds;
      });
      await Promise.all(ownerIds.map(async (id) => {
        try {
          const warnings = await cleanupRetiredAgent(this.prisma, this.computerFetch, this.agentData, id);
          for (const warning of warnings) console.warn(`bot archive cleanup: ${warning}`);
        } catch (error) {
          // The retirement transaction already queued the retry, including if this process exits.
          console.warn(`bot archive cleanup ${id}: ${String(error)}`);
        }
      }));
      return { ok: true };
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
    await this.agentData.projectBot(bot.id);
    const store = await this.computerFetch(COMPUTER_API_PATHS.agentStore(bot.id), { method: "PUT", body: JSON.stringify({ createdAt: bot.createdAt.getTime() }), signal: AbortSignal.timeout(15_000) });
    if (!store.ok) throw new ApiError(503, "agent_store_unavailable", await store.text());
    return toBotView(bot);
  }
}
