import type { ComputerEvent, InlineImageInput, RunOrigin, SubagentType } from "@openbot/contracts";
import { createPrismaClient, Prisma, type PrismaClient } from "@openbot/db";
import {
  AgentDataStore,
  AgentMessaging,
  appendRoutineRunLedger,
  buildSafeTranscript,
  RoutineService,
} from "@openbot/messaging";
import { fromPrisma, type Job, type JobWithMetadata, PgBoss } from "pg-boss";
import { pluginRuntimeContext } from "./plugins";
import { Projection } from "./projection";

const LEASE_MS = 2 * 60_000;

class BotRunLeaseContended extends Error {}

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
  inboxType: string;
  runId: string;
  botId: string;
  contextSessionId: string;
  screenBotId: string;
  pluginBotId: string;
  conversationId: string;
  ownerId: string;
  content: string;
  automationTrigger: string | null;
  images: InlineImageInput[];
  clientId: string;
  cwd: string;
  instructions: string;
  sessionPath: string | null;
  channelId: string;
  deliveryId: string | null;
  origin: RunOrigin;
  runtimeProfile: "agent" | "subagent";
  subagentType: SubagentType | null;
  fileAttachments: string[];
}

export const contextScopeForRun = (
  _origin: RunOrigin,
  _channelId: string | null,
  conversationId: string
): { scope: "home"; scopeId: string } => ({ scope: "home", scopeId: conversationId });

export const subagentRuntimeOwners = (
  botId: string,
  identity: { parentBotId: string; subagentType: string } | null
): { screenBotId: string; pluginBotId: string } => ({
  screenBotId:
    identity && ["computerUse", "browserUse"].includes(identity.subagentType)
      ? identity.parentBotId
      : botId,
  pluginBotId: identity?.subagentType === "executor" ? identity.parentBotId : botId,
});

export const subagentLoadsPluginContext = (subagentType: SubagentType | null): boolean =>
  subagentType !== "computerUse" && subagentType !== "browserUse";

export const wakeResetsSelfSummaryCount = (inboxType: string): boolean =>
  !["subagent.completed", "subagent.failed", "subagent.stopped", "subagent.cancelled"].includes(
    inboxType
  );

export const automationTriggerForWake = (
  origin: RunOrigin,
  content: string,
  supplied: string | null = null
): string | null => {
  if (origin !== "routine") return null;
  const suppliedMatch = supplied?.match(
    /<automation_trigger_info>[\s\S]*?<\/automation_trigger_info>/i
  )?.[0];
  if (suppliedMatch) return suppliedMatch;
  return (
    content.match(/<automation_trigger_info>[\s\S]*?<\/automation_trigger_info>/i)?.[0] ?? null
  );
};

export const subagentCompletionEnvelope = (result: string): string => {
  const summary =
    result
      .match(
        /<user_visible_high_level_summary>\s*([\s\S]*?)\s*<\/user_visible_high_level_summary>/i
      )?.[1]
      ?.trim() || result.trim();
  const response =
    result.match(/<response>\s*([\s\S]*?)\s*<\/response>/i)?.[1]?.trim() || result.trim();
  return [
    "A background subagent completed. This is a private wake for the parent; no Task card or child result has been added to the user-visible transcript. Reconcile your todos before continuing.",
    "Treat <user_visible_high_level_summary> as candidate text for a normal user-facing message. Normally send a concise completion update, but stay quiet when the user explicitly asked you not to restate the result. Never expose <response> verbatim unless its details are necessary and appropriate for the user.",
    "",
    "<user_visible_high_level_summary>",
    summary,
    "</user_visible_high_level_summary>",
    "",
    "<response>",
    response,
    "</response>",
  ].join("\n");
};

const inlineImages = (value: unknown): InlineImageInput[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (candidate): candidate is { url: string; alt?: unknown } =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        typeof (candidate as { url?: unknown }).url === "string" &&
        /^data:image\/(?:gif|jpeg|png|webp);base64,/i.test((candidate as { url: string }).url)
    )
    .map((candidate) => ({
      url: candidate.url,
      ...(typeof candidate.alt === "string" ? { alt: candidate.alt.slice(0, 2_000) } : {}),
    }))
    .slice(0, 8);
};

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

export const resolveTurnMemoryExchange = (input: {
  visibleUser?: { content: string; createdAt: Date } | null;
  internalUser?: { content: string; createdAt: Date } | null;
  visibleAssistant: Array<{ content: string }>;
  internalAssistant?: { content: string } | null;
}): { user: string; assistant: string; occurredAt: number } | null => {
  const user = input.visibleUser?.content.trim() || input.internalUser?.content.trim() || "";
  const assistant =
    input.visibleAssistant
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n") ||
    input.internalAssistant?.content.trim() ||
    "";
  if (!user || !assistant) return null;
  return {
    user,
    assistant,
    occurredAt: (
      input.visibleUser?.createdAt ??
      input.internalUser?.createdAt ??
      new Date()
    ).getTime(),
  };
};

export const terminalRoutineExecutionStatus = (
  runStatus: string
): "completed" | "failed" | "cancelled" | null => {
  if (runStatus === "completed") return "completed";
  if (runStatus === "cancelled") return "cancelled";
  if (runStatus === "failed" || runStatus === "interrupted") return "failed";
  return null;
};

export class WakeWorker {
  readonly prisma: PrismaClient;
  readonly boss: PgBoss;
  readonly projection: Projection;
  readonly computerUrl: string;
  readonly controlToken: string;
  readonly agentData: AgentDataStore;
  readonly messaging: AgentMessaging;
  readonly routines: RoutineService;
  private routineTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    this.prisma = createPrismaClient(databaseUrl);
    this.boss = new PgBoss(databaseUrl);
    this.computerUrl = process.env.OPENBOT_COMPUTER_URL ?? "http://127.0.0.1:8790";
    this.controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
    this.agentData = new AgentDataStore(this.prisma, {
      memoryInference: async (request) => {
        const response = await fetch(`${this.computerUrl}/v1/infer`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.controlToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
        const body = (await response.json()) as { text?: unknown; error?: unknown };
        if (!response.ok || typeof body.text !== "string") {
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : `Memory inference failed (${response.status})`
          );
        }
        return body.text;
      },
    });
    this.projection = new Projection(this.prisma, this.agentData);
    this.messaging = new AgentMessaging(this.prisma, this.boss, this.agentData);
    this.routines = new RoutineService(this.prisma, this.messaging, this.agentData);
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
    await this.recoverRoutineExecutions();
    await this.agentData.reconcileAllActiveBots();
    await this.agentData.startMemoryLifecycle();
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
      await this.agentData.reconcileAllActiveBots();
      await this.recoverRoutineExecutions();
      await this.routines.dispatchDue();
    });
    this.routineTimer = setInterval(() => {
      void this.recoverRoutineExecutions()
        .then(() => this.routines.dispatchDue())
        .catch((error) => console.error("routine-dispatch", error));
    }, 1_000);
    this.routineTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.routineTimer) clearInterval(this.routineTimer);
    this.routineTimer = null;
    await this.agentData.stopMemoryLifecycle();
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
        const lease = await tx.botRunLease.findUnique({
          where: { botId: event.botId },
        });
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

  private async recoverRoutineExecutions(): Promise<void> {
    const executions = await this.prisma.routineExecution.findMany({
      where: {
        status: { in: ["queued", "running", "waiting_approval"] },
        runId: { not: null },
        routine: { bot: { status: "active" } },
      },
      select: {
        id: true,
        runId: true,
        routine: { select: { botId: true } },
        run: { select: { status: true, completedAt: true, error: true } },
      },
      take: 100,
    });
    for (const execution of executions) {
      if (!execution.runId || !execution.run) continue;
      const status = terminalRoutineExecutionStatus(execution.run.status);
      if (!status) continue;
      const updated = await this.prisma.routineExecution.updateMany({
        where: {
          id: execution.id,
          status: { in: ["queued", "running", "waiting_approval"] },
        },
        data: {
          status,
          completedAt: execution.run.completedAt ?? new Date(),
          ...(status === "completed" ? {} : { error: execution.run.error ?? Prisma.JsonNull }),
        },
      });
      if (updated.count > 0) {
        await this.syncRoutineRunFile(execution.routine.botId, execution.runId);
      }
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
      await this.agentData.projectBot(botId);
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
          const subagent = await tx.subagent.findUnique({
            where: { childBotId: botId },
          });
          if (subagent && !["completed", "failed", "stopped"].includes(subagent.status)) {
            const attempt = subagent.currentRunId
              ? await tx.subagentAttempt.findUnique({
                  where: { childRunId: subagent.currentRunId },
                })
              : null;
            await tx.subagent.update({
              where: { id: subagent.id },
              data: {
                status: "failed",
                completedAt: new Date(),
                error: { code: "provisioning_failed", message },
              },
            });
            if (attempt) {
              await tx.subagentAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: "failed",
                  completedAt: new Date(),
                  error: { code: "provisioning_failed", message },
                },
              });
            }
            if (attempt?.runInBackground) {
              await this.notifySubagentParent(
                tx,
                {
                  ...subagent,
                  parentChannelId: attempt.parentChannelId,
                  description: attempt.description,
                  currentRunId: attempt.childRunId,
                },
                "failed",
                message
              );
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
          images?: unknown;
          clientId?: string;
          channelId?: string;
          automationTrigger?: unknown;
        };
        if (!payload.content || !payload.clientId) {
          await tx.inboxEvent.update({
            where: { id: inbox.id },
            data: { status: "failed", error: { code: "invalid_payload" } },
          });
          return null;
        }
        const lease = await tx.botRunLease.createMany({
          data: {
            botId,
            runId: inbox.runId,
            ownerId,
            expiresAt: new Date(Date.now() + LEASE_MS),
          },
          skipDuplicates: true,
        });
        if (lease.count === 0) throw new BotRunLeaseContended();
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
          await tx.subagentAttempt.updateMany({
            where: {
              subagentId: inbox.bot.subagentIdentity.id,
              childRunId: inbox.runId,
              status: { in: ["provisioning", "queued"] },
            },
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
        const runtimeOwners = subagentRuntimeOwners(botId, inbox.bot.subagentIdentity);
        const contextAddress = contextScopeForRun(
          inbox.run.origin,
          inbox.run.channelId,
          inbox.conversationId
        );
        const contextSession = await tx.contextSession.upsert({
          where: {
            botId_scope_scopeId: {
              botId,
              scope: contextAddress.scope,
              scopeId: contextAddress.scopeId,
            },
          },
          create: {
            botId,
            scope: contextAddress.scope,
            scopeId: contextAddress.scopeId,
            ...(contextAddress.scope === "home"
              ? {
                  runtimeSessionId: inbox.bot.runtimeSessionId,
                  runtimeSessionPath: inbox.bot.runtimeSessionPath,
                  compactionEpoch: inbox.conversation.compactionEpoch,
                }
              : {}),
          },
          update: {},
        });
        return {
          inboxId: inbox.id,
          inboxType: inbox.type,
          runId: inbox.runId,
          botId,
          contextSessionId: contextSession.id,
          ...runtimeOwners,
          conversationId: inbox.conversationId,
          ownerId,
          content: payload.content,
          automationTrigger:
            typeof payload.automationTrigger === "string" ? payload.automationTrigger : null,
          images: inlineImages(payload.images),
          clientId: payload.clientId,
          cwd:
            inbox.run.origin === "group" && inbox.run.channel?.workingDirectory
              ? inbox.run.channel.workingDirectory
              : inbox.bot.defaultDirectory,
          instructions: inbox.bot.instructions,
          sessionPath: contextSession.runtimeSessionPath,
          channelId: inbox.run.channelId ?? String(payload.channelId ?? ""),
          deliveryId: inbox.run.deliveryId,
          origin: inbox.run.origin,
          runtimeProfile: inbox.bot.subagentIdentity ? "subagent" : "agent",
          subagentType:
            (inbox.bot.subagentIdentity?.subagentType as SubagentType | undefined) ?? null,
          fileAttachments: Array.isArray(inbox.bot.subagentIdentity?.fileAttachments)
            ? inbox.bot.subagentIdentity.fileAttachments.filter(
                (value): value is string => typeof value === "string"
              )
            : [],
        };
      });
    } catch (error) {
      if (error instanceof BotRunLeaseContended) return null;
      const code = (error as { code?: string }).code;
      if (code === "P2002") return null;
      throw error;
    }
  }

  private async execute(claimed: Claimed): Promise<void> {
    const heartbeat = setInterval(() => void this.heartbeat(claimed), 30_000);
    let completion: Extract<ComputerEvent, { type: "turn.completed" }> | null = null;
    try {
      await this.reconcileContextState(claimed);
      const [platformPrompt, pluginContext] = await Promise.all([
        this.messaging.platformPrompt(claimed.botId, claimed.contextSessionId),
        subagentLoadsPluginContext(claimed.subagentType)
          ? pluginRuntimeContext(this.prisma, claimed.pluginBotId)
          : Promise.resolve({ dynamicNamespaces: [], skillInstructions: "" }),
      ]);
      // Plugin skills are global/read-only inputs. Bot-owned saved skills are
      // rendered later by platformInstructions and therefore win on conflict.
      const instructions = `${pluginContext.skillInstructions}${platformPrompt.instructions}`;
      const response = await fetch(`${this.computerUrl}/v1/turns`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: claimed.runId,
          botId: claimed.botId,
          contextSessionId: claimed.contextSessionId,
          screenBotId: claimed.screenBotId,
          conversationId: claimed.conversationId,
          sessionPath: claimed.sessionPath,
          content: claimed.content,
          images: claimed.images,
          clientMessageId: claimed.clientId,
          cwd: claimed.cwd,
          instructions,
          userInfo: platformPrompt.userInfo,
          userInfoEpoch: platformPrompt.userInfoEpoch ?? undefined,
          todoUpdate: platformPrompt.todoUpdate,
          automationTrigger: automationTriggerForWake(
            claimed.origin,
            claimed.content,
            claimed.automationTrigger
          ),
          resetSelfSummaryCount: wakeResetsSelfSummaryCount(claimed.inboxType),
          channelId: claimed.channelId,
          deliveryId: claimed.deliveryId,
          runtimeProfile: claimed.runtimeProfile,
          subagentType: claimed.subagentType ?? undefined,
          fileAttachments: claimed.fileAttachments,
          dynamicNamespaces: pluginContext.dynamicNamespaces,
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
      await this.agentData.acknowledgeIdentityAnnouncement(claimed.botId, claimed.contextSessionId);
      await this.recordMemoryFromRun(claimed);
      await this.syncRoutineRunFile(claimed.botId, claimed.runId);
      if (claimed.deliveryId) {
        await this.messaging.completeDelivery(claimed.deliveryId, "completed");
      }
    } catch (error) {
      await this.fail(claimed, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async reconcileContextState(claimed: Claimed): Promise<void> {
    const response = await this.computerFetch(`/v1/context-sessions/${claimed.contextSessionId}`, {
      method: "GET",
    });
    // Preserve compatibility with a rolling deployment whose computer service
    // has not learned the preflight endpoint yet. Its turn stream still carries
    // context.state and will reconcile after startup.
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(
        `Context-state preflight failed: ${response.status} ${await response.text()}`
      );
    }
    const event = (await response.json()) as ComputerEvent;
    if (event.type !== "context.state" || event.contextSessionId !== claimed.contextSessionId) {
      throw new Error("Computer returned an invalid context-state preflight response");
    }
    await this.projection.apply(claimed.runId, claimed.conversationId, claimed.botId, event);
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
    let priorityInterrupted = false;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.run.findUnique({ where: { id: claimed.runId } });
      const currentError =
        current?.error && !Array.isArray(current.error) && typeof current.error === "object"
          ? (current.error as Prisma.InputJsonObject)
          : null;
      priorityInterrupted = currentError?.code === "priority_peer_interrupt";
      const failureDetails = priorityInterrupted && currentError ? currentError : details;
      const finalStatus =
        current?.status === "cancelled"
          ? "cancelled"
          : current?.status === "failed"
            ? "failed"
            : "interrupted";
      await tx.run.update({
        where: { id: claimed.runId },
        data: { status: finalStatus, error: failureDetails, completedAt: new Date() },
      });
      await tx.inboxEvent.update({
        where: { id: claimed.inboxId },
        data: { status: "failed", error: failureDetails, completedAt: new Date() },
      });
      await tx.routineExecution.updateMany({
        where: {
          runId: claimed.runId,
          status: { in: ["queued", "running", "waiting_approval"] },
        },
        data: { status: "failed", error: failureDetails, completedAt: new Date() },
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
                ...failureDetails,
              },
            },
          });
        }
      }
      await tx.approval.updateMany({
        where: {
          runId: claimed.runId,
          status: "pending",
          requestMethod: { not: "plugin/tool" },
        },
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
          payload: failureDetails,
        },
      });
      await this.messaging.scheduleTranscriptProjection(tx, [claimed.botId]);
      await this.failSubagent(tx, claimed, failureDetails);
    });
    await this.syncRoutineRunFile(claimed.botId, claimed.runId);
    if (claimed.deliveryId) {
      if (claimed.origin === "group" && priorityInterrupted) {
        await this.messaging.retryInterruptedGroupDelivery(claimed.deliveryId, claimed.runId);
      } else {
        await this.messaging.completeDelivery(claimed.deliveryId, "failed", details);
      }
    }
  }

  private async syncRoutineRunFile(botId: string, runId: string): Promise<void> {
    const execution = await this.prisma.routineExecution.findUnique({
      where: { runId },
      select: {
        id: true,
        routineId: true,
        kind: true,
        status: true,
        scheduledFor: true,
        enqueuedAt: true,
        startedAt: true,
        completedAt: true,
        runId: true,
        skipReason: true,
        error: true,
        routine: { select: { runLedger: true } },
      },
    });
    if (!execution) return;
    const status =
      execution.status === "completed"
        ? "ok"
        : execution.status === "queued" ||
            execution.status === "running" ||
            execution.status === "waiting_approval"
          ? "running"
          : "error";
    await this.prisma.routine.update({
      where: { id: execution.routineId },
      data: {
        runLedger: appendRoutineRunLedger(execution.routine.runLedger, {
          id: execution.id,
          trigger: execution.kind === "scheduled" ? "schedule" : "manual",
          startedAt: (
            execution.startedAt ??
            execution.enqueuedAt ??
            execution.scheduledFor
          ).getTime(),
          finishedAt: execution.completedAt?.getTime() ?? null,
          status,
          ...(execution.skipReason ? { detail: execution.skipReason } : {}),
          ...(execution.error &&
          !Array.isArray(execution.error) &&
          typeof execution.error === "object" &&
          typeof (execution.error as { code?: unknown }).code === "string"
            ? { errorKind: (execution.error as { code: string }).code }
            : {}),
        }),
      },
    });
    await this.agentData.writeRoutine(botId, execution.routineId);
  }

  private async recordMemoryFromRun(claimed: Claimed): Promise<void> {
    const [inbox, messages, visibleAssistant] = await Promise.all([
      this.prisma.inboxEvent.findUnique({
        where: { id: claimed.inboxId },
        select: { payload: true },
      }),
      this.prisma.message.findMany({
        where: { runId: claimed.runId, status: "completed" },
        select: { role: true, content: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.channelMessage.findMany({
        where: {
          sourceRunId: claimed.runId,
          sender: "agent",
          senderBotId: claimed.botId,
        },
        select: { content: true },
        orderBy: { sequence: "asc" },
      }),
    ]);
    const payload =
      inbox?.payload && typeof inbox.payload === "object" && !Array.isArray(inbox.payload)
        ? (inbox.payload as Record<string, unknown>)
        : null;
    const visibleUser =
      claimed.channelId && typeof payload?.clientId === "string"
        ? await this.prisma.channelMessage.findUnique({
            where: {
              channelId_clientId: {
                channelId: claimed.channelId,
                clientId: payload.clientId,
              },
            },
            select: { content: true, createdAt: true },
          })
        : null;
    const internalUser = messages.find((message) => message.role === "user");
    const internalAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const exchange = resolveTurnMemoryExchange({
      visibleUser,
      internalUser,
      visibleAssistant,
      internalAssistant,
    });
    if (!exchange) return;
    await this.agentData.recordTurnMemory(claimed.botId, {
      user: exchange.user,
      assistant: exchange.assistant,
      hidden: !["user", "group"].includes(claimed.origin),
      occurredAt: exchange.occurredAt,
    });
  }

  private async completeSubagent(tx: Prisma.TransactionClient, claimed: Claimed): Promise<void> {
    const subagent = await tx.subagent.findFirst({
      where: { childBotId: claimed.botId, currentRunId: claimed.runId },
    });
    const attempt = await tx.subagentAttempt.findUnique({
      where: { childRunId: claimed.runId },
    });
    if (
      !subagent ||
      !attempt ||
      ["completed", "failed", "stopped"].includes(subagent.status) ||
      ["completed", "failed", "stopped"].includes(attempt.status)
    ) {
      return;
    }
    const finalMessage = await tx.message.findFirst({
      where: { runId: claimed.runId, role: "assistant", status: "completed" },
      orderBy: { updatedAt: "desc" },
    });
    const result = finalMessage?.content.trim() || "Subagent completed without a text report.";
    await tx.subagent.update({
      where: { id: subagent.id },
      data: {
        status: "completed",
        result,
        error: Prisma.DbNull,
        completedAt: new Date(),
      },
    });
    await tx.subagentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "completed",
        result,
        error: Prisma.DbNull,
        completedAt: new Date(),
      },
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
          attemptId: attempt.id,
          parentToolCallId: attempt.parentToolCallId,
        },
      },
    });
    if (attempt.runInBackground) {
      await this.notifySubagentParent(
        tx,
        {
          ...subagent,
          parentChannelId: attempt.parentChannelId,
          description: attempt.description,
          currentRunId: attempt.childRunId,
        },
        "completed",
        result
      );
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
    const attempt = await tx.subagentAttempt.findUnique({
      where: { childRunId: claimed.runId },
    });
    if (
      !subagent ||
      !attempt ||
      ["completed", "failed", "stopped"].includes(subagent.status) ||
      ["completed", "failed", "stopped"].includes(attempt.status)
    ) {
      return;
    }
    await tx.subagent.update({
      where: { id: subagent.id },
      data: { status: "failed", error: details, completedAt: new Date() },
    });
    await tx.subagentAttempt.update({
      where: { id: attempt.id },
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
          attemptId: attempt.id,
          parentToolCallId: attempt.parentToolCallId,
          ...details,
        },
      },
    });
    if (attempt.runInBackground) {
      await this.notifySubagentParent(
        tx,
        {
          ...subagent,
          parentChannelId: attempt.parentChannelId,
          description: attempt.description,
          currentRunId: attempt.childRunId,
        },
        "failed",
        details.message as string
      );
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
    const parent = await tx.bot.findUnique({
      where: { id: subagent.parentBotId },
    });
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
        status === "completed" ? subagentCompletionEnvelope(result) : result,
      ].join("\n"),
      clientId: `subagent:${subagent.id}:${status}:${subagent.currentRunId}`,
      priority: 260,
    });
  }
}
