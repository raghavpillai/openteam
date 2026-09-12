import { ApiError, type BotView, type DuplicateBotInput } from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openteam/db";
import type { AgentDataStore } from "@openteam/messaging";
import { fromPrisma, type PgBoss } from "pg-boss";
import { appendEvent, type ComputerFetch, hashRequest, toJson } from "./service-utils";
import { toBotView } from "./view-mappers";

interface Dependencies {
  prisma: PrismaClient;
  boss: PgBoss;
  agentData: AgentDataStore;
  computerFetch: ComputerFetch;
}

/** A new identity and empty conversation with the source's durable configuration. */
export async function duplicateBot(
  { prisma, boss, agentData, computerFetch }: Dependencies,
  sourceId: string,
  input: DuplicateBotInput
): Promise<BotView> {
  const scope = "bot:duplicate";
  const requestHash = hashRequest({ sourceId, ...input });
  const requestKey = { scope_key: { scope, key: input.clientRequestId } };
  const finish = async (record: { requestHash: string; response: Prisma.JsonValue | null }) => {
    if (record.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This request id was used for a different duplicate"
      );
    }
    const response = record.response as { botId?: string } | null;
    if (!response?.botId)
      throw new ApiError(409, "request_in_progress", "This bot is being duplicated");
    const bot = await prisma.bot.findUniqueOrThrow({
      where: { id: response.botId },
      include: { conversation: true, channelMemberships: { include: { channel: true } } },
    });
    // This PUT is idempotent. A retry after a computer outage finishes the same
    // duplicate instead of copying newer source state or creating another bot.
    const store = await computerFetch(COMPUTER_API_PATHS.agentStore(bot.id), {
      method: "PUT",
      body: JSON.stringify({ createdAt: bot.createdAt.getTime() }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!store.ok) throw new ApiError(503, "agent_store_unavailable", await store.text());
    return toBotView(bot);
  };
  const previous = await prisma.idempotencyRecord.findUnique({ where: requestKey });
  if (previous) return finish(previous);

  await agentData.reconcileBot(sourceId);
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const dmChannelId = crypto.randomUUID();
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${sourceId}`}))`;
        await tx.idempotencyRecord.create({
          data: {
            scope,
            key: input.clientRequestId,
            requestHash,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
          },
        });
        const source = await tx.bot.findUnique({
          where: { id: sourceId },
          include: {
            subagentIdentity: { select: { id: true } },
            routines: { where: { deletedAt: null } },
            pluginEnablements: true,
            pluginConnectionGrants: true,
            pluginToolPolicies: true,
          },
        });
        if (!source || source.status === "archived" || source.subagentIdentity) {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        const name = `${source.name.slice(0, 75)} copy`;
        await tx.bot.create({
          data: {
            id: botId,
            name,
            title: source.title,
            description: source.description,
            instructions: source.instructions,
            icon: source.icon,
            color: source.color,
            namedBy: "app",
            notificationsEnabled: source.notificationsEnabled,
            hiddenFromSidebar: false,
            dreamingEnabled: source.dreamingEnabled,
            defaultDirectory: source.defaultDirectory,
            runtimeEngine: source.runtimeEngine,
            inferenceProvider: source.inferenceProvider,
            inferenceModel: source.inferenceModel,
            status: "provisioning",
            // Duplicates open with no greeting, bootstrap turn, or inherited context.
            onboardingStatus: "completed",
            onboardingCompletedAt: new Date(),
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
        for (const routine of source.routines) {
          const copy = await tx.routine.create({
            data: {
              botId,
              slug: routine.slug,
              name: routine.name,
              prompt: routine.prompt,
              trigger: toJson(routine.trigger),
              triggerPresentation:
                routine.triggerPresentation === null
                  ? Prisma.DbNull
                  : toJson(routine.triggerPresentation),
              provenance: routine.provenance,
              scheduleText: routine.scheduleText,
              scheduleKind: routine.scheduleKind,
              cronExpression: routine.cronExpression,
              intervalSeconds: routine.intervalSeconds,
              timezoneMode: routine.timezoneMode,
              timezone: routine.timezone,
              enabled: routine.enabled,
              nextRunAt: routine.nextRunAt,
              lastRunAt: routine.lastRunAt,
              pausedAt: routine.pausedAt,
              createdAt: routine.createdAt,
              pendingNotices: toJson(routine.pendingNotices),
              raisedNotices: toJson(routine.raisedNotices),
              // automation.json state survives; runs.json and execution records do not.
              runLedger: [],
            },
          });
          await tx.routineRevision.create({
            data: {
              routineId: copy.id,
              revision: 1,
              name: copy.name,
              prompt: copy.prompt,
              scheduleText: copy.scheduleText,
              scheduleKind: copy.scheduleKind,
              cronExpression: copy.cronExpression,
              intervalSeconds: copy.intervalSeconds,
              timezoneMode: copy.timezoneMode,
              timezone: copy.timezone,
              enabled: copy.enabled,
              source: "duplicate",
            },
          });
        }
        // Reuse account installations/connections, including the source's restrictions.
        // Credentials, invocations, and activity history are never duplicated.
        await tx.botPluginEnablement.createMany({
          data: source.pluginEnablements.map((entry) => ({
            botId,
            installationId: entry.installationId,
            enabled: entry.enabled,
            skillsEnabled: entry.skillsEnabled,
          })),
        });
        await tx.botPluginConnectionGrant.createMany({
          data: source.pluginConnectionGrants.map((entry) => ({
            botId,
            connectionId: entry.connectionId,
            enabled: entry.enabled,
          })),
        });
        await tx.pluginToolPolicy.createMany({
          data: source.pluginToolPolicies.map((entry) => ({
            botId,
            connectionId: entry.connectionId,
            toolName: entry.toolName,
            decision: entry.decision,
          })),
        });
        await agentData.copyBotConfigurationFiles(tx, sourceId, botId);
        await appendEvent(tx, "bot.created", botId, {
          botId,
          conversationId,
          dmChannelId,
          duplicatedFromBotId: sourceId,
        });
        await boss.send(
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
          where: requestKey,
          data: {
            status: "completed",
            response: toJson({ botId }),
          },
        });
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  } catch (error) {
    // The transaction rolled back; remove only this newly minted bot's files.
    await agentData.deleteAgentFiles(botId);
    if ((error as { code?: string }).code !== "P2002") throw error;
    const winner = await prisma.idempotencyRecord.findUnique({ where: requestKey });
    if (!winner) throw error;
    return finish(winner);
  }
  return finish({ requestHash, response: { botId } });
}
