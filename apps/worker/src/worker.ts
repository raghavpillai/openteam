import type { ComputerEvent, RunOrigin } from "@openbot/contracts";
import { createPrismaClient, Prisma, type PrismaClient } from "@openbot/db";
import { AgentMessaging, buildSafeTranscript, RoutineService } from "@openbot/messaging";
import { fromPrisma, type Job, type JobWithMetadata, PgBoss } from "pg-boss";
import { Projection } from "./projection";

const LEASE_MS = 2 * 60_000;

interface WakeData {
  botId: string;
}

interface ProvisionData {
  botId: string;
}

interface TranscriptData {
  botId: string;
}

interface Claimed {
  inboxId: string;
  runId: string;
  botId: string;
  conversationId: string;
  ownerId: string;
  content: string;
  clientId: string;
  cwd: string;
  instructions: string;
  sessionPath: string | null;
  channelId: string;
  deliveryId: string | null;
  origin: RunOrigin;
  runtimeProfile: "agent" | "subagent";
  fileAttachments: string[];
}

export const turnCompletionFailure = (
  event: Extract<ComputerEvent, { type: "turn.completed" }>
): Error | null => {
  if (event.status === "completed") return null;
  const runtimeMessage =
    event.error &&
    typeof event.error === "object" &&
    "message" in event.error &&
    typeof event.error.message === "string"
      ? event.error.message
      : null;
  return new Error(runtimeMessage ?? `Computer turn ended with status ${event.status}`);
};

export class WakeWorker {
  readonly prisma: PrismaClient;
  readonly boss: PgBoss;
  readonly projection: Projection;
  readonly computerUrl: string;
  readonly controlToken: string;
  readonly messaging: AgentMessaging;
  readonly routines: RoutineService;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    this.prisma = createPrismaClient(databaseUrl);
    this.boss = new PgBoss(databaseUrl);
    this.projection = new Projection(this.prisma);
    this.computerUrl = process.env.OPENBOT_COMPUTER_URL ?? "http://127.0.0.1:8790";
    this.controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
    this.messaging = new AgentMessaging(this.prisma, this.boss);
    this.routines = new RoutineService(this.prisma, this.messaging);
    this.boss.on("error", (error) => console.error("pg-boss", error));
  }

  async start(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue("bot-wake");
    await this.boss.createQueue("bot-provision");
    await this.boss.createQueue("transcript-project");
    await this.boss.createQueue("routine-dispatch");
    await this.boss.schedule("routine-dispatch", "* * * * *");
    await this.messaging.recoverRounds();
    await this.recoverDurableWork();
    await this.boss.work<WakeData>(
      "bot-wake",
      {
        batchSize: 1,
        localConcurrency: Number(process.env.OPENBOT_WORKER_CONCURRENCY ?? 8),
      },
      async (jobs) => {
        const job = jobs[0];
        if (job) await this.handle(job);
      }
    );
    await this.boss.work<ProvisionData>(
      "bot-provision",
      { batchSize: 1, includeMetadata: true },
      async (jobs) => {
        const job = jobs[0];
        if (job) await this.handleProvision(job as JobWithMetadata<ProvisionData>);
      }
    );
    await this.boss.work<TranscriptData>("transcript-project", { batchSize: 1 }, async (jobs) => {
      const job = jobs[0];
      if (job) await this.handleTranscript(job);
    });
    await this.boss.work("routine-dispatch", { batchSize: 1 }, async () => {
      await this.routines.dispatchDue();
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true });
    await this.prisma.$disconnect();
  }

  private async recoverDurableWork(): Promise<void> {
    const provisioning = await this.prisma.bot.findMany({
      where: { status: "provisioning" },
      select: { id: true },
    });
    for (const bot of provisioning) {
      await this.boss.send(
        "bot-provision",
        { botId: bot.id },
        {
          retryLimit: 8,
          retryDelay: 2,
          retryBackoff: true,
          expireInSeconds: 3 * 60,
        }
      );
    }

    const bootstrap = await this.prisma.bot.findMany({
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
    for (const bot of bootstrap) {
      const channelId = bot.channelMemberships[0]?.channelId;
      if (!channelId) continue;
      await this.prisma.$transaction((tx) =>
        this.messaging.enqueueBootstrap(tx, bot.id, channelId)
      );
    }

    const orphanedSteers = await this.prisma.inboxEvent.findMany({
      where: {
        deliveryMode: "steer",
        status: { in: ["pending", "processing"] },
      },
      distinct: ["botId"],
      select: { botId: true },
    });
    for (const event of orphanedSteers) {
      await this.prisma.$transaction(async (tx) => {
        await tx.botRunLease.deleteMany({
          where: { botId: event.botId, expiresAt: { lt: new Date() } },
        });
        const lease = await tx.botRunLease.findUnique({ where: { botId: event.botId } });
        if (!lease) {
          await this.messaging.promoteOrphanedSteers(
            tx,
            event.botId,
            "worker_recovered_orphaned_steer"
          );
        }
      });
    }

    const pending = await this.prisma.inboxEvent.findMany({
      where: {
        deliveryMode: "turn",
        status: "pending",
        availableAt: { lte: new Date() },
        bot: { status: "active" },
      },
      distinct: ["botId"],
      select: { botId: true },
    });
    for (const event of pending) {
      await this.boss.send(
        "bot-wake",
        { botId: event.botId },
        {
          retryLimit: 5,
          retryDelay: 2,
          retryBackoff: true,
          expireInSeconds: 3 * 60,
        }
      );
    }
  }

  private async handleProvision(job: JobWithMetadata<ProvisionData>): Promise<void> {
    const botId = job.data.botId;
    const bot = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provision:${botId}`}))`;
      return tx.bot.findUnique({
        where: { id: botId },
        include: {
          channelMemberships: {
            where: { channel: { kind: "bot_dm", archivedAt: null } },
            select: { channelId: true },
            take: 1,
          },
        },
      });
    });
    if (!bot || bot.status === "archived" || bot.status === "active") return;
    if (bot.status === "failed") return;

    try {
      const response = await this.computerFetch(`/v1/workspaces/${bot.id}`, {
        method: "PUT",
        body: JSON.stringify({ path: bot.defaultDirectory }),
        signal: AbortSignal.timeout(3 * 60_000),
      });
      if (!response.ok) throw new Error(await response.text());
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provision:${botId}`}))`;
        const current = await tx.bot.findUnique({ where: { id: botId } });
        if (!current || current.status === "archived") return;
        await tx.bot.update({
          where: { id: botId },
          data: { status: "active", provisioningError: Prisma.DbNull },
        });
        await tx.event.create({
          data: {
            topic: "bot.ready",
            entityId: botId,
            payload: { botId, defaultDirectory: bot.defaultDirectory },
          },
        });
        const channelId = bot.channelMemberships[0]?.channelId;
        if (channelId && current.onboardingStatus === "pending") {
          await this.messaging.enqueueBootstrap(tx, botId, channelId);
        }
        const pending = await tx.inboxEvent.count({
          where: {
            botId,
            deliveryMode: "turn",
            status: "pending",
            availableAt: { lte: new Date() },
          },
        });
        if (pending > 0) {
          await this.boss.send(
            "bot-wake",
            { botId },
            {
              db: fromPrisma(tx),
              retryLimit: 5,
              retryDelay: 2,
              retryBackoff: true,
              expireInSeconds: 3 * 60,
            }
          );
        }
        await this.messaging.scheduleTranscriptProjection(tx, [botId]);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalAttempt = job.retryCount >= job.retryLimit;
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.bot.findUnique({ where: { id: botId } });
        if (!current || current.status === "archived") return;
        await tx.bot.update({
          where: { id: botId },
          data: {
            status: finalAttempt ? "failed" : "provisioning",
            provisioningError: {
              message,
              retryCount: job.retryCount,
              finalAttempt,
            },
          },
        });
        await tx.event.create({
          data: {
            topic: finalAttempt ? "bot.provisioning_failed" : "bot.provisioning_retry",
            entityId: botId,
            payload: {
              botId,
              message,
              retryCount: job.retryCount,
              finalAttempt,
            },
          },
        });
        if (finalAttempt) {
          const subagent = await tx.subagent.findUnique({ where: { childBotId: botId } });
          if (subagent && !["completed", "failed", "stopped"].includes(subagent.status)) {
            await tx.subagent.update({
              where: { id: subagent.id },
              data: {
                status: "failed",
                completedAt: new Date(),
                error: { code: "provisioning_failed", message },
              },
            });
            if (subagent.runInBackground) {
              await this.notifySubagentParent(tx, subagent, "failed", message);
            }
          }
        }
      });
      throw error;
    }
  }

  private async handleTranscript(job: Job<TranscriptData>): Promise<void> {
    const bot = await this.prisma.bot.findUnique({
      where: { id: job.data.botId },
    });
    if (!bot || bot.status === "archived") return;
    const transcript = await buildSafeTranscript(this.prisma, bot.id);
    const response = await this.computerFetch(`/v1/transcripts/${bot.id}`, {
      method: "PUT",
      body: JSON.stringify(transcript),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Transcript projection failed: ${await response.text()}`);
  }

  private async handle(job: Job<WakeData>): Promise<void> {
    const botId = job.data.botId;
    while (true) {
      const claimed = await this.claim(botId);
      if (!claimed) return;
      await this.execute(claimed);
    }
  }

  private async claim(botId: string): Promise<Claimed | null> {
    const ownerId = crypto.randomUUID();
    const staleAt = new Date(Date.now() - LEASE_MS);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.botRunLease.deleteMany({
          where: { botId, expiresAt: { lt: new Date() } },
        });
        const existingLease = await tx.botRunLease.findUnique({
          where: { botId },
        });
        if (existingLease) return null;
        await this.messaging.promoteOrphanedSteers(tx, botId, "orphaned_active_turn");
        await tx.inboxEvent.updateMany({
          where: {
            botId,
            deliveryMode: "turn",
            status: "processing",
            claimedAt: { lt: staleAt },
          },
          data: { status: "pending", claimedAt: null },
        });
        const inbox = await tx.inboxEvent.findFirst({
          where: {
            botId,
            deliveryMode: "turn",
            status: "pending",
            availableAt: { lte: new Date() },
            bot: { status: "active" },
          },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
          include: {
            bot: { include: { subagentIdentity: true } },
            conversation: true,
            run: { include: { channel: true } },
          },
        });
        if (!inbox) return null;
        const payload = inbox.payload as {
          content?: string;
          clientId?: string;
          channelId?: string;
        };
        if (!payload.content || !payload.clientId) {
          await tx.inboxEvent.update({
            where: { id: inbox.id },
            data: { status: "failed", error: { code: "invalid_payload" } },
          });
          return null;
        }
        await tx.botRunLease.create({
          data: {
            botId,
            runId: inbox.runId,
            ownerId,
            expiresAt: new Date(Date.now() + LEASE_MS),
          },
        });
        await tx.inboxEvent.update({
          where: { id: inbox.id },
          data: {
            status: "processing",
            claimedAt: new Date(),
            attempts: { increment: 1 },
          },
        });
        if (inbox.run.deliveryId) {
          await tx.channelDelivery.update({
            where: { id: inbox.run.deliveryId },
            data: { status: "processing", startedAt: new Date() },
          });
        }
        await tx.run.update({
          where: { id: inbox.runId },
          data: { status: "running", startedAt: new Date() },
        });
        if (
          inbox.bot.subagentIdentity?.currentRunId === inbox.runId &&
          ["provisioning", "queued"].includes(inbox.bot.subagentIdentity.status)
        ) {
          await tx.subagent.update({
            where: { id: inbox.bot.subagentIdentity.id },
            data: { status: "running", startedAt: new Date() },
          });
        }
        await tx.routineExecution.updateMany({
          where: { runId: inbox.runId, status: "queued" },
          data: { status: "running", startedAt: new Date() },
        });
        if (inbox.run.origin === "bootstrap") {
          await tx.bot.update({
            where: { id: botId },
            data: { onboardingStatus: "running" },
          });
          await tx.event.create({
            data: {
              topic: "bot.bootstrap.started",
              entityId: botId,
              payload: { botId, runId: inbox.runId },
            },
          });
        }
        await tx.event.create({
          data: {
            topic: "inbox.claimed",
            entityId: inbox.id,
            payload: { inboxId: inbox.id, runId: inbox.runId, ownerId },
          },
        });
        return {
          inboxId: inbox.id,
          runId: inbox.runId,
          botId,
          conversationId: inbox.conversationId,
          ownerId,
          content: payload.content,
          clientId: payload.clientId,
          cwd:
            inbox.run.origin === "group" && inbox.run.channel?.workingDirectory
              ? inbox.run.channel.workingDirectory
              : inbox.bot.defaultDirectory,
          instructions: inbox.bot.instructions,
          sessionPath: inbox.bot.runtimeSessionPath,
          channelId: inbox.run.channelId ?? String(payload.channelId ?? ""),
          deliveryId: inbox.run.deliveryId,
          origin: inbox.run.origin,
          runtimeProfile: inbox.bot.subagentIdentity ? "subagent" : "agent",
          fileAttachments: Array.isArray(inbox.bot.subagentIdentity?.fileAttachments)
            ? inbox.bot.subagentIdentity.fileAttachments.filter(
                (value): value is string => typeof value === "string"
              )
            : [],
        };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002") return null;
      throw error;
    }
  }

  private async execute(claimed: Claimed): Promise<void> {
    const heartbeat = setInterval(() => void this.heartbeat(claimed), 30_000);
    let completion: Extract<ComputerEvent, { type: "turn.completed" }> | null = null;
    try {
      const instructions = await this.messaging.platformInstructions(claimed.botId);
      const response = await fetch(`${this.computerUrl}/v1/turns`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: claimed.runId,
          botId: claimed.botId,
          conversationId: claimed.conversationId,
          sessionPath: claimed.sessionPath,
          content: claimed.content,
          clientMessageId: claimed.clientId,
          cwd: claimed.cwd,
          instructions,
          channelId: claimed.channelId,
          deliveryId: claimed.deliveryId,
          runtimeProfile: claimed.runtimeProfile,
          fileAttachments: claimed.fileAttachments,
        }),
        signal: AbortSignal.timeout(24 * 60 * 60_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Computer rejected turn: ${response.status} ${await response.text()}`);
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += value ?? "";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ComputerEvent;
          await this.projection.apply(claimed.runId, claimed.conversationId, claimed.botId, event);
          if (event.type === "turn.completed") completion = event;
        }
        if (done) break;
      }
      if (!completion)
        throw new Error("Computer stream ended without an authoritative turn completion");
      const completionFailure = turnCompletionFailure(completion);
      if (completionFailure) throw completionFailure;
      await this.prisma.$transaction(async (tx) => {
        const completedAt = new Date();
        await tx.inboxEvent.update({
          where: { id: claimed.inboxId },
          data: { status: "completed", completedAt },
        });
        await tx.routineExecution.updateMany({
          where: {
            runId: claimed.runId,
            status: { in: ["queued", "running", "waiting_approval"] },
          },
          data: { status: "completed", completedAt },
        });
        if (claimed.origin === "bootstrap") {
          const onboarding = await tx.bot.updateMany({
            where: { id: claimed.botId, onboardingStatus: "running" },
            data: {
              onboardingStatus: "completed",
              onboardingCompletedAt: completedAt,
            },
          });
          if (onboarding.count > 0) {
            await tx.event.create({
              data: {
                topic: "bot.bootstrap.completed",
                entityId: claimed.botId,
                payload: { botId: claimed.botId, runId: claimed.runId },
              },
            });
          }
        }
        await this.messaging.promoteUndeliveredSteers(
          tx,
          claimed.runId,
          "active_turn_completed_before_delivery"
        );
        await tx.botRunLease.deleteMany({
          where: { botId: claimed.botId, ownerId: claimed.ownerId },
        });
        await tx.event.create({
          data: {
            topic: "inbox.completed",
            entityId: claimed.inboxId,
            payload: { inboxId: claimed.inboxId, runId: claimed.runId },
          },
        });
        await this.messaging.scheduleTranscriptProjection(tx, [claimed.botId]);
        await this.completeSubagent(tx, claimed);
      });
      if (claimed.deliveryId) {
        await this.messaging.completeDelivery(claimed.deliveryId, "completed");
      }
    } catch (error) {
      await this.fail(claimed, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async heartbeat(claimed: Claimed): Promise<void> {
    await this.prisma.botRunLease.updateMany({
      where: { botId: claimed.botId, ownerId: claimed.ownerId },
      data: {
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
  }

  private computerFetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.computerUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  }

  private async fail(claimed: Claimed, error: unknown): Promise<void> {
    const details = {
      code: "runtime_interrupted",
      message: error instanceof Error ? error.message : String(error),
    } satisfies Prisma.InputJsonObject;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.run.findUnique({ where: { id: claimed.runId } });
      const finalStatus =
        current?.status === "cancelled"
          ? "cancelled"
          : current?.status === "failed"
            ? "failed"
            : "interrupted";
      await tx.run.update({
        where: { id: claimed.runId },
        data: { status: finalStatus, error: details, completedAt: new Date() },
      });
      await tx.inboxEvent.update({
        where: { id: claimed.inboxId },
        data: { status: "failed", error: details, completedAt: new Date() },
      });
      await tx.routineExecution.updateMany({
        where: { runId: claimed.runId, status: { in: ["queued", "running", "waiting_approval"] } },
        data: { status: "failed", error: details, completedAt: new Date() },
      });
      if (claimed.origin === "bootstrap") {
        const onboarding = await tx.bot.updateMany({
          where: { id: claimed.botId, onboardingStatus: "running" },
          data: {
            onboardingStatus: "failed",
            onboardingCompletedAt: new Date(),
          },
        });
        if (onboarding.count > 0) {
          await tx.event.create({
            data: {
              topic: "bot.bootstrap.failed",
              entityId: claimed.botId,
              payload: {
                botId: claimed.botId,
                runId: claimed.runId,
                ...details,
              },
            },
          });
        }
      }
      await tx.approval.updateMany({
        where: { runId: claimed.runId, status: "pending" },
        data: { status: "expired", resolvedAt: new Date() },
      });
      await this.messaging.promoteUndeliveredSteers(
        tx,
        claimed.runId,
        "active_turn_ended_before_delivery"
      );
      await tx.botRunLease.deleteMany({
        where: { botId: claimed.botId, ownerId: claimed.ownerId },
      });
      await tx.event.create({
        data: {
          topic: "run.interrupted",
          entityId: claimed.runId,
          payload: details,
        },
      });
      await this.messaging.scheduleTranscriptProjection(tx, [claimed.botId]);
      await this.failSubagent(tx, claimed, details);
    });
    if (claimed.deliveryId) {
      await this.messaging.completeDelivery(claimed.deliveryId, "failed", details);
    }
  }

  private async completeSubagent(tx: Prisma.TransactionClient, claimed: Claimed): Promise<void> {
    const subagent = await tx.subagent.findFirst({
      where: { childBotId: claimed.botId, currentRunId: claimed.runId },
    });
    if (!subagent || subagent.status === "stopped") return;
    const finalMessage = await tx.message.findFirst({
      where: { runId: claimed.runId, role: "assistant", status: "completed" },
      orderBy: { updatedAt: "desc" },
    });
    const result = finalMessage?.content.trim() || "Subagent completed without a text report.";
    await tx.subagent.update({
      where: { id: subagent.id },
      data: { status: "completed", result, error: Prisma.DbNull, completedAt: new Date() },
    });
    await tx.event.create({
      data: {
        topic: "subagent.completed",
        entityId: subagent.id,
        payload: {
          subagentId: subagent.id,
          parentBotId: subagent.parentBotId,
          childBotId: subagent.childBotId,
          runId: claimed.runId,
        },
      },
    });
    if (subagent.runInBackground) {
      await this.notifySubagentParent(tx, subagent, "completed", result);
    }
  }

  private async failSubagent(
    tx: Prisma.TransactionClient,
    claimed: Claimed,
    details: Prisma.InputJsonObject
  ): Promise<void> {
    const subagent = await tx.subagent.findFirst({
      where: { childBotId: claimed.botId, currentRunId: claimed.runId },
    });
    if (!subagent || subagent.status === "stopped") return;
    await tx.subagent.update({
      where: { id: subagent.id },
      data: { status: "failed", error: details, completedAt: new Date() },
    });
    await tx.event.create({
      data: {
        topic: "subagent.failed",
        entityId: subagent.id,
        payload: {
          subagentId: subagent.id,
          parentBotId: subagent.parentBotId,
          childBotId: subagent.childBotId,
          runId: claimed.runId,
          ...details,
        },
      },
    });
    if (subagent.runInBackground) {
      await this.notifySubagentParent(tx, subagent, "failed", details.message as string);
    }
  }

  private async notifySubagentParent(
    tx: Prisma.TransactionClient,
    subagent: {
      id: string;
      parentBotId: string;
      parentChannelId: string;
      description: string;
      currentRunId: string | null;
      outputPath: string;
    },
    status: "completed" | "failed",
    result: string
  ): Promise<void> {
    const parent = await tx.bot.findUnique({ where: { id: subagent.parentBotId } });
    if (!parent || !["active", "provisioning"].includes(parent.status)) return;
    await this.messaging.enqueueWake(tx, {
      botId: subagent.parentBotId,
      channelId: subagent.parentChannelId,
      origin: "agent",
      type: `subagent.${status}`,
      content: [
        `[Background subagent ${status}]`,
        `Agent ID: ${subagent.id}`,
        `Task: ${subagent.description}`,
        `Transcript: ${subagent.outputPath}`,
        "",
        result,
      ].join("\n"),
      clientId: `subagent:${subagent.id}:${status}:${subagent.currentRunId}`,
      priority: 260,
    });
  }
}
