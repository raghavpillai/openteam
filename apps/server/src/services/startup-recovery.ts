import type { PrismaClient } from "@openteam/db";
import { type AgentMessaging, renderSubagentRevivalPrompt, subagentRevivalBlock } from "@openteam/messaging";
import { subagentTitle } from "@openteam/contracts/subagent-dispatch";
import type { PgBoss } from "pg-boss";
import type { ComputerFetch } from "./service-utils";
import { appendEvent } from "./service-utils";
import { SUBAGENT_RECOVERY_RUN_STATUSES, subagentRestartError } from "./subagent/recovery";

export const RESTART_INTERRUPTED_NOTICE =
  "This reply was interrupted by a restart. Send your message again to continue.";

/** Turns a person is waiting on. Background work (routines, Tasks, events) reports through its own paths. */
const NOTICE_ORIGINS = ["user", "handoff_resume"] as const;

export async function recover(
  prisma: PrismaClient,
  boss: PgBoss,
  messaging: AgentMessaging,
  computerFetch: ComputerFetch
): Promise<void> {
  const now = new Date();
  const archivedParentChildren = await prisma.subagent.findMany({
    where: { parentBot: { status: "archived" } },
    select: {
      id: true,
      parentBotId: true,
      childBotId: true,
      currentRunId: true,
      status: true,
    },
  });
  await prisma.$transaction(async (tx) => {
    const activeRuns = await tx.run.findMany({
      where: { status: { in: [...SUBAGENT_RECOVERY_RUN_STATUSES] } },
      select: { id: true },
    });
    const activeRunIds = activeRuns.map((run) => run.id);
    const interruptedSubagents = await tx.subagent.findMany({
      where: {
        currentRunId: { in: activeRunIds },
        status: { in: ["provisioning", "queued", "running"] },
        parentBot: { status: { not: "archived" } },
      },
    });
    const subagentRunIds = new Set(interruptedSubagents.map((subagent) => subagent.currentRunId));
    const cutOffTurns = await tx.run.findMany({
      where: {
        status: "running",
        origin: { in: [...NOTICE_ORIGINS] },
        channel: { archivedAt: null },
        bot: { status: { not: "archived" } },
      },
      select: { id: true, botId: true, channelId: true },
    });
    const interrupted = await tx.run.updateMany({
      where: { status: { in: ["running"] } },
      data: {
        status: "interrupted",
        completedAt: now,
        error: {
          code: "runtime_restart",
          message: "Runtime restarted during this turn",
        },
      },
    });
    const wokenParents = new Set<string>();
    for (const subagent of interruptedSubagents) {
      const attempt = subagent.currentRunId
        ? await tx.subagentAttempt.findUnique({
            where: { childRunId: subagent.currentRunId },
          })
        : null;
      const error = subagentRestartError;
      await tx.subagent.updateMany({
        where: {
          id: subagent.id,
          status: { in: ["provisioning", "queued", "running"] },
        },
        data: { status: "failed", error, completedAt: now },
      });
      if (attempt) {
        await tx.subagentAttempt.updateMany({
          where: {
            id: attempt.id,
            status: { in: ["provisioning", "queued", "running"] },
          },
          data: { status: "failed", error, completedAt: now },
        });
      }
      if (subagent.currentRunId) {
        await tx.run.updateMany({
          where: {
            id: subagent.currentRunId,
            status: { in: [...SUBAGENT_RECOVERY_RUN_STATUSES] },
          },
          data: { status: "interrupted", completedAt: now, error },
        });
        await tx.inboxEvent.updateMany({
          where: {
            runId: subagent.currentRunId,
            status: { in: ["pending", "processing"] },
          },
          data: { status: "completed", completedAt: now, error },
        });
        await tx.botRunLease.deleteMany({ where: { runId: subagent.currentRunId } });
      }
      await appendEvent(tx, "subagent.failed", subagent.id, {
        subagentId: subagent.id,
        parentBotId: subagent.parentBotId,
        childBotId: subagent.childBotId,
        runId: subagent.currentRunId,
        attemptId: attempt?.id,
        parentToolCallId: attempt?.parentToolCallId,
        ...error,
      });
      if (attempt) {
        const parent = await tx.bot.findUnique({
          where: { id: subagent.parentBotId },
          select: { status: true },
        });
        if (parent && ["active", "provisioning"].includes(parent.status)) {
          wokenParents.add(`${subagent.parentBotId}:${attempt.parentChannelId}`);
          await messaging.enqueueWake(tx, {
            botId: subagent.parentBotId,
            channelId: attempt.parentChannelId,
            origin: "background_revival",
            type: "subagent.failed",
            content: renderSubagentRevivalPrompt({
              title: subagentTitle(attempt.prompt),
              subagentType: subagent.subagentType,
              status: "failed",
              result: error.message,
            }),
            revival: {
              block: subagentRevivalBlock({ title: subagentTitle(attempt.prompt), subagentType: subagent.subagentType, status: "failed", result: error.message }),
              subagentType: subagent.subagentType,
            },
            clientId: `subagent:${subagent.id}:failed:${subagent.currentRunId}`,
            priority: 260,
          });
        }
      }
    }
    // Say so in the chat, once per turn, without waking the bot: the person decides whether to ask again.
    // A bot woken above about its failed Task speaks in that chat itself.
    for (const run of cutOffTurns) {
      if (!run.channelId || subagentRunIds.has(run.id) || wokenParents.has(`${run.botId}:${run.channelId}`)) continue;
      await tx.channelMessage.createMany({
        data: [{
          channelId: run.channelId,
          clientId: `restart-interrupted:${run.id}`,
          sender: "system",
          content: RESTART_INTERRUPTED_NOTICE,
          metadata: { type: "event", event: { type: "turn-interrupted", reason: "restart", runId: run.id } },
          createdAt: now,
        }],
        skipDuplicates: true,
      });
    }
    const orphanedActiveChildren = archivedParentChildren.filter((child) =>
      ["provisioning", "queued", "running"].includes(child.status)
    );
    for (const child of orphanedActiveChildren) {
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
        data: { status: "stopped", stoppedAt: now, completedAt: now },
      });
      if (attempt) {
        await tx.subagentAttempt.updateMany({
          where: {
            id: attempt.id,
            status: { in: ["provisioning", "queued", "running"] },
          },
          data: { status: "stopped", stoppedAt: now, completedAt: now },
        });
      }
      if (child.currentRunId) {
        await tx.run.updateMany({
          where: {
            id: child.currentRunId,
            status: { in: ["queued", "running", "interrupted"] },
          },
          data: {
            status: "cancelled",
            completedAt: now,
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
            completedAt: now,
            error: { code: "parent_archived" },
          },
        });
        await tx.botRunLease.deleteMany({ where: { runId: child.currentRunId } });
      }
      await appendEvent(tx, "subagent.stopped", child.id, {
        subagentId: child.id,
        parentBotId: child.parentBotId,
        childBotId: child.childBotId,
        runId: child.currentRunId,
        attemptId: attempt?.id,
        parentToolCallId: attempt?.parentToolCallId,
        reason: "parent_archived_recovery",
      });
    }
    const orphanedChildBotIds = archivedParentChildren.map((child) => child.childBotId);
    await tx.bot.updateMany({
      where: { id: { in: orphanedChildBotIds } },
      data: { status: "archived" },
    });
    await tx.channel.updateMany({
      where: { directKey: { in: orphanedChildBotIds.map((id) => `bot:${id}`) } },
      data: { archivedAt: now },
    });
    await tx.botRunLease.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.inboxEvent.updateMany({
      where: {
        status: "processing",
        claimedAt: { lt: new Date(now.getTime() - 15 * 60_000) },
      },
      data: { status: "pending", claimedAt: null },
    });
    if (interrupted.count > 0) {
      await appendEvent(tx, "runtime.recovered", null, {
        interruptedRuns: interrupted.count,
      });
    }
  });
  await Promise.all(
    archivedParentChildren.map((child) =>
      computerFetch(`/v1/screens/${child.childBotId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined)
    )
  );
  const provisioningBots = await prisma.bot.findMany({
    where: { status: "provisioning" },
    select: { id: true },
  });
  for (const { id: botId } of provisioningBots) {
    await boss.send(
      "bot-provision",
      { botId },
      {
        retryLimit: 8,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 3 * 60,
      }
    );
  }
  const pendingBootstraps = await prisma.bot.findMany({
    where: { status: "active", onboardingStatus: "pending" },
    select: {
      id: true,
      channelMemberships: {
        where: { channel: { kind: "bot_dm", archivedAt: null } },
        select: { channelId: true },
        take: 1,
      },
    },
  });
  for (const bot of pendingBootstraps) {
    const channelId = bot.channelMemberships[0]?.channelId;
    if (!channelId) continue;
    await prisma.$transaction((tx) => messaging.enqueueBootstrap(tx, bot.id, channelId));
  }
  const pendingBots = await prisma.inboxEvent.findMany({
    where: {
      status: "pending",
      availableAt: { lte: now },
      bot: { status: "active" },
    },
    distinct: ["botId"],
    select: { botId: true },
  });
  for (const { botId } of pendingBots) {
    await boss.send("bot-wake", { botId }, { retryLimit: 5, retryDelay: 2, retryBackoff: true });
  }
  await messaging.recoverRounds();
}
