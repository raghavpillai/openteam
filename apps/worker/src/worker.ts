import { createHash } from "node:crypto";
import type {
  AssetRef,
  ComputerEvent,
  ComputerTurnRequest,
  RunOrigin,
  RuntimeRequestSource,
  RuntimeInlineImage,
  SubagentType,
} from "@openbot/contracts";
import { SEND_TO_USER_REPLY_NUDGE_PROMPT } from "@openbot/contracts";
import {
  COMPUTER_API_PATHS,
  parseAgentDirectorySnapshot,
  parseComputerEvent,
  type AgentDirectoryRecord,
} from "@openbot/contracts/service-protocol";
import {
  agentNotificationPresentation,
  notificationMessageInputReason,
  notificationMessagePreview,
} from "@openbot/contracts";
import { createPrismaClient, Prisma, type PrismaClient } from "@openbot/db";
import {
  appendAgentTimelineEvent,
  AgentDataStore,
  AgentMessaging,
  appendRoutineRunLedger,
  buildSafeTranscript,
  PRIORITY,
  RoutineService,
  renderSubagentRevivalPrompt,
} from "@openbot/messaging";
import { fromPrisma, type Job, type JobWithMetadata, PgBoss } from "pg-boss";
import { pluginRuntimeContext } from "./plugins";
import { Projection } from "./projection";
import { enqueuePushNotification, PushNotificationDispatcher } from "./push-notifications";

const LEASE_MS = 2 * 60_000;
export const AUTOMATION_RECONCILE_BATCH_SIZE = 8;
export const TRANSCRIPT_FINGERPRINT_TTL_MS = 5_000;
export const TRANSCRIPT_FINGERPRINT_CACHE_MAX_ENTRIES = 1_024;

export const computerEventQueuesPushNotification = (event: ComputerEvent): boolean =>
  event.type === "approval.requested" || event.type === "turn.completed";

interface TranscriptFingerprintEntry {
  value: string;
  expiresAt: number;
}

/** Small per-process LRU used only to suppress duplicate transcript uploads. */
export class TranscriptFingerprintCache {
  private readonly entries = new Map<string, TranscriptFingerprintEntry>();

  constructor(
    readonly maxEntries = TRANSCRIPT_FINGERPRINT_CACHE_MAX_ENTRIES,
    readonly ttlMs = TRANSCRIPT_FINGERPRINT_TTL_MS
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Transcript fingerprint cache maxEntries must be a positive integer");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Transcript fingerprint cache ttlMs must be positive");
    }
  }

  matches(botId: string, value: string, now = Date.now()): boolean {
    const entry = this.entries.get(botId);
    if (!entry) return false;
    if (entry.expiresAt <= now) {
      this.entries.delete(botId);
      return false;
    }
    // Reinsert on access so Map insertion order is the LRU order.
    this.entries.delete(botId);
    this.entries.set(botId, entry);
    return entry.value === value;
  }

  remember(botId: string, value: string, now = Date.now()): void {
    this.entries.delete(botId);
    this.entries.set(botId, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const transcriptEventsFingerprint = (events: unknown): string =>
  createHash("sha256").update(JSON.stringify(events)).digest("hex");

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
  images: RuntimeInlineImage[];
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

const REQUEST_SOURCE_BY_ORIGIN = {
  user: "turn",
  bootstrap: "turn",
  agent: "agent",
  group: "agent",
  routine: "automation",
  event: "event",
  connector: "connector",
  background_revival: "background-revival",
  handoff_resume: "handoff-resume",
  broadcast: "broadcast",
} as const satisfies Record<RunOrigin, RuntimeRequestSource>;

export const runtimeRequestSourceForOrigin = (origin: RunOrigin): RuntimeRequestSource =>
  REQUEST_SOURCE_BY_ORIGIN[origin];

export const runOwesUserDelivery = (origin: RunOrigin): boolean =>
  ["user", "bootstrap", "connector", "handoff_resume", "broadcast"].includes(origin);

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

export const pluginSkillPromptForRuntime = (
  runtimeProfile: "agent" | "subagent",
  skillInstructions: string
): string => (runtimeProfile === "agent" ? skillInstructions : "");

export const wakeResetsSelfSummaryCount = (inboxType: string): boolean =>
  ![
    "subagent.completed",
    "subagent.failed",
    "subagent.stopped",
    "subagent.cancelled",
    "timeline.event",
  ].includes(inboxType);

export const turnContentWithProfileUpdate = (
  profileUpdate: string | null,
  content: string
): string => [profileUpdate, content].filter(Boolean).join("\n\n");

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

const assetRefs = (value: unknown): AssetRef[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (candidate): candidate is AssetRef =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        typeof (candidate as { assetId?: unknown }).assetId === "string" &&
        /^[a-f0-9]{64}$/.test((candidate as { assetId: string }).assetId) &&
        typeof (candidate as { fileName?: unknown }).fileName === "string" &&
        typeof (candidate as { mimeType?: unknown }).mimeType === "string" &&
        typeof (candidate as { byteSize?: unknown }).byteSize === "number" &&
        ["image", "video", "audio", "pdf", "text", "file"].includes(
          String((candidate as { kind?: unknown }).kind)
        )
    )
    .slice(0, 6);
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

export const terminalGroupRoutineExecutionStatus = (
  roundStatus: string,
  deliveryStatuses: readonly string[]
): "completed" | "failed" | null => {
  if (roundStatus === "failed") return "failed";
  if (roundStatus !== "completed") return null;
  return deliveryStatuses.length > 0 &&
    deliveryStatuses.every((status) => status === "failed" || status === "skipped")
    ? "failed"
    : "completed";
};

export class WakeWorker {
  readonly prisma: PrismaClient;
  readonly boss: PgBoss;
  readonly projection: Projection;
  readonly computerUrl: string;
  readonly controlToken: string;
  readonly workspaceRoot: string;
  readonly agentData: AgentDataStore;
  readonly messaging: AgentMessaging;
  readonly routines: RoutineService;
  readonly pushNotifications: PushNotificationDispatcher;
  private routineTimer: ReturnType<typeof setInterval> | null = null;
  private agentStoreTimer: ReturnType<typeof setInterval> | null = null;
  private pushNotificationTimer: ReturnType<typeof setInterval> | null = null;
  private reconcilingAgentStores = false;
  private routinePassActive = false;
  private automationReconcileCursor: string | null = null;
  private agentStoreEtag: string | null = null;
  private pendingAgentStoreRecords = new Map<string, AgentDirectoryRecord>();
  private readonly transcriptFingerprints = new TranscriptFingerprintCache();

  constructor() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    this.prisma = createPrismaClient(databaseUrl);
    this.boss = new PgBoss(databaseUrl);
    this.computerUrl = process.env.OPENBOT_COMPUTER_URL ?? "http://127.0.0.1:8790";
    this.controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
    this.workspaceRoot = process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace";
    this.agentData = new AgentDataStore(this.prisma, {
      memoryInference: async (request) => {
        const response = await fetch(`${this.computerUrl}${COMPUTER_API_PATHS.inference}`, {
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
    this.agentData.setTimelineEventSink((tx, input) =>
      appendAgentTimelineEvent(tx, this.messaging, input)
    );
    this.routines = new RoutineService(this.prisma, this.messaging, this.agentData);
    this.pushNotifications = new PushNotificationDispatcher(this.prisma);
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
    await this.reconcileAgentStores();
    await this.agentData.reconcileAllActiveBots();
    await this.agentData.startMemoryLifecycle();
    await this.pushNotifications.drain();
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
      await this.dispatchRoutinePass();
    });
    this.routineTimer = setInterval(() => {
      void this.dispatchRoutinePass().catch((error) => console.error("routine-dispatch", error));
    }, 1_000);
    this.routineTimer.unref();
    this.agentStoreTimer = setInterval(() => {
      if (this.reconcilingAgentStores) return;
      this.reconcilingAgentStores = true;
      void this.reconcileAgentStores(false)
        .then(async (adopted) => {
          if (adopted > 0) await this.agentData.reconcileAllActiveBots();
        })
        .catch((error) => console.error("agent-store-reconcile", error))
        .finally(() => {
          this.reconcilingAgentStores = false;
        });
    }, 5_000);
    this.agentStoreTimer.unref();
    this.pushNotificationTimer = setInterval(() => {
      void this.pushNotifications
        .drain()
        .catch((error) => console.error("push notification delivery", error));
    }, 2_000);
    this.pushNotificationTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.routineTimer) clearInterval(this.routineTimer);
    this.routineTimer = null;
    if (this.agentStoreTimer) clearInterval(this.agentStoreTimer);
    this.agentStoreTimer = null;
    if (this.pushNotificationTimer) clearInterval(this.pushNotificationTimer);
    this.pushNotificationTimer = null;
    await this.agentData.stopMemoryLifecycle();
    await this.boss.stop({ graceful: true });
    await this.prisma.$disconnect();
  }

  private async dispatchRoutinePass(): Promise<void> {
    if (this.routinePassActive) return;
    this.routinePassActive = true;
    try {
      const reconciliation = await this.agentData.reconcileAutomationFilesBatch(
        this.automationReconcileCursor,
        AUTOMATION_RECONCILE_BATCH_SIZE
      );
      this.automationReconcileCursor = reconciliation.nextCursor;
      await this.recoverRoutineExecutions();
      await this.routines.dispatchDue();
    } finally {
      this.routinePassActive = false;
    }
  }

  private async reconcileAgentStores(backfill = true): Promise<number> {
    const directoryResponse = await this.computerFetch(COMPUTER_API_PATHS.agentStores, {
      method: "GET",
      headers:
        !backfill && this.agentStoreEtag ? { "if-none-match": this.agentStoreEtag } : undefined,
    });
    if (directoryResponse.status === 304) {
      if (this.pendingAgentStoreRecords.size === 0) return 0;
    } else if (!directoryResponse.ok) {
      throw new Error(`Agent directory discovery failed: ${await directoryResponse.text()}`);
    }
    const responseEtag =
      directoryResponse.status === 304 ? null : directoryResponse.headers.get("etag");
    const directoryPayload =
      directoryResponse.status === 304
        ? null
        : parseAgentDirectorySnapshot(await directoryResponse.json());
    const directories = directoryPayload
      ? directoryPayload.agents.filter((record) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            record.id
          )
        )
      : [...this.pendingAgentStoreRecords.values()];

    let adopted = 0;
    const pending = new Map<string, AgentDirectoryRecord>();
    const agentRecords = directories.filter(({ kind }) => kind === "agent");
    const existingBotIds = new Set(
      agentRecords.length === 0
        ? []
        : (
            await this.prisma.bot.findMany({
              where: { id: { in: agentRecords.map(({ id }) => id) } },
              select: { id: true },
            })
          ).map(({ id }) => id)
    );
    for (const record of agentRecords) {
      if (existingBotIds.has(record.id)) continue;
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`adopt-agent:${record.id}`}))`;
        if (await tx.bot.findUnique({ where: { id: record.id } })) return false;
        await tx.bot.create({
          data: {
            id: record.id,
            name: record.name || "New Bot",
            title: record.title,
            description: record.description,
            namedBy: "user",
            notificationsEnabled: record.notifyOnAgentUpdates,
            hiddenFromSidebar: record.hiddenFromSidebar,
            defaultDirectory: this.workspaceRoot,
            status: "active",
            onboardingStatus: "completed",
            onboardingCompletedAt: new Date(record.createdAt),
            createdAt: new Date(record.createdAt),
            conversation: { create: { createdAt: new Date(record.createdAt) } },
          },
        });
        await tx.channel.create({
          data: {
            kind: "bot_dm",
            name: record.name || "New Bot",
            directKey: `bot:${record.id}`,
            createdAt: new Date(record.createdAt),
            members: { create: { botId: record.id, ordinal: 0 } },
          },
        });
        return true;
      });
      if (created) adopted += 1;
    }

    const groupRecords = directories.filter(({ kind }) => kind === "group");
    const existingChannelIds = new Set(
      groupRecords.length === 0
        ? []
        : (
            await this.prisma.channel.findMany({
              where: { id: { in: groupRecords.map(({ id }) => id) } },
              select: { id: true },
            })
          ).map(({ id }) => id)
    );
    const missingGroupRecords = groupRecords.filter(({ id }) => !existingChannelIds.has(id));
    const candidateGroupMemberIds = [
      ...new Set(missingGroupRecords.flatMap(({ memberIds }) => memberIds.slice(0, 6))),
    ];
    const activeGroupMemberIds = new Set(
      candidateGroupMemberIds.length === 0
        ? []
        : (
            await this.prisma.bot.findMany({
              where: {
                id: { in: candidateGroupMemberIds },
                status: "active",
                subagentIdentity: { is: null },
              },
              select: { id: true },
            })
          ).map(({ id }) => id)
    );
    for (const record of groupRecords) {
      if (existingChannelIds.has(record.id)) continue;
      const memberIds = [...new Set(record.memberIds)].slice(0, 6);
      if (memberIds.length === 0) continue;
      if (memberIds.some((memberId) => !activeGroupMemberIds.has(memberId))) {
        pending.set(record.id, record);
        continue;
      }
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`adopt-group:${record.id}`}))`;
        if (await tx.channel.findUnique({ where: { id: record.id } })) return false;
        await tx.channel.create({
          data: {
            id: record.id,
            kind: "group",
            name: record.name || "Group",
            description: record.description,
            workingDirectory: this.workspaceRoot,
            createdAt: new Date(record.createdAt),
            members: {
              create: memberIds.map((botId, ordinal) => ({ botId, ordinal })),
            },
          },
        });
        return true;
      });
      if (created) adopted += 1;
    }

    this.pendingAgentStoreRecords = pending;
    if (responseEtag) this.agentStoreEtag = responseEtag;

    if (!backfill) return adopted;

    const [bots, groups] = await Promise.all([
      this.prisma.bot.findMany({
        where: { status: { in: ["active", "provisioning"] }, subagentIdentity: { is: null } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.channel.findMany({
        where: { kind: "group", archivedAt: null },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    for (const owner of [...bots, ...groups]) {
      const response = await this.computerFetch(COMPUTER_API_PATHS.agentStore(owner.id), {
        method: "PUT",
        body: JSON.stringify({ createdAt: owner.createdAt.getTime() }),
      });
      if (!response.ok) {
        throw new Error(`Agent store backfill failed for ${owner.id}: ${await response.text()}`);
      }
    }
    const response = await this.computerFetch(COMPUTER_API_PATHS.reconcileAgentStores, {
      method: "POST",
      body: JSON.stringify({ ownerIds: [...bots, ...groups].map(({ id }) => id) }),
    });
    if (!response.ok) {
      throw new Error(`Agent store ownership reconciliation failed: ${await response.text()}`);
    }
    for (const bot of bots) {
      await this.boss.send("transcript-project", { botId: bot.id });
    }
    return adopted;
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
        OR: [{ runId: { not: null } }, { channelMessageId: { not: null } }],
        routine: {
          OR: [{ bot: { status: "active" } }, { channel: { kind: "group", archivedAt: null } }],
        },
      },
      select: {
        id: true,
        runId: true,
        channelMessageId: true,
        routine: { select: { botId: true, channelId: true } },
        run: { select: { status: true, completedAt: true, error: true } },
      },
      take: 100,
    });
    for (const execution of executions) {
      if (execution.runId && execution.run) {
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
        if (updated.count > 0 && execution.routine.botId) {
          await this.syncRoutineRunFile(execution.routine.botId, execution.runId);
        }
        continue;
      }
      if (execution.channelMessageId && execution.routine.channelId) {
        await this.recoverGroupRoutineExecution(execution.id, execution.channelMessageId);
      }
    }
  }

  private async recoverGroupRoutineExecution(
    executionId: string,
    rootMessageId: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const execution = await tx.routineExecution.findUnique({
        where: { id: executionId },
        include: { routine: { select: { runLedger: true, channelId: true } } },
      });
      if (
        !execution ||
        !execution.routine.channelId ||
        !["queued", "running", "waiting_approval"].includes(execution.status)
      ) {
        return;
      }
      const round = await tx.channelRound.findFirst({
        where: { rootMessageId },
        orderBy: { roundIndex: "desc" },
        include: { deliveries: { select: { status: true } } },
      });
      if (!round) return;
      const status = terminalGroupRoutineExecutionStatus(
        round.status,
        round.deliveries.map(({ status: deliveryStatus }) => deliveryStatus)
      );
      if (!status) return;
      const finishedAt = round.completedAt ?? new Date();
      const errorKind =
        status === "failed"
          ? round.status === "failed"
            ? "group_routine_round_failed"
            : "group_routine_delivery_failed"
          : null;
      const updated = await tx.routineExecution.updateMany({
        where: {
          id: execution.id,
          status: { in: ["queued", "running", "waiting_approval"] },
        },
        data: {
          status,
          completedAt: finishedAt,
          ...(errorKind ? { error: { code: errorKind } } : {}),
        },
      });
      if (updated.count === 0) return;
      await tx.routine.update({
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
            finishedAt: finishedAt.getTime(),
            status: status === "completed" ? "ok" : "error",
            ...(errorKind ? { errorKind } : {}),
          }),
        },
      });
      await tx.event.create({
        data: {
          topic: `routine.execution.${status}`,
          entityId: execution.id,
          payload: {
            executionId: execution.id,
            routineId: execution.routineId,
            channelId: execution.routine.channelId,
            rootMessageId,
            status,
            recovered: true,
          },
        },
      });
    });
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
    const fingerprint = transcriptEventsFingerprint(transcript.events);
    if (this.transcriptFingerprints.matches(bot.id, fingerprint)) return;
    const response = await this.computerFetch(`/v1/transcripts/${bot.id}`, {
      method: "PUT",
      body: JSON.stringify(transcript),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Transcript projection failed: ${await response.text()}`);
    this.transcriptFingerprints.remember(bot.id, fingerprint);
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
          attachments?: unknown;
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
          images: await this.messaging.assets.runtimeImages(assetRefs(payload.attachments)),
          clientId: payload.clientId,
          cwd: this.workspaceRoot,
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
      // Plugin skills are global/read-only inputs. User workflows are rendered
      // later by platformInstructions and therefore win on conflict.
      const instructions = `${pluginSkillPromptForRuntime(
        claimed.runtimeProfile,
        pluginContext.skillInstructions
      )}${platformPrompt.instructions}`;
      const turnRequest = {
        runId: claimed.runId,
        botId: claimed.botId,
        contextSessionId: claimed.contextSessionId,
        screenBotId: claimed.screenBotId,
        conversationId: claimed.conversationId,
        sessionPath: claimed.sessionPath,
        content: turnContentWithProfileUpdate(platformPrompt.agentProfileUpdate, claimed.content),
        images: claimed.images,
        clientMessageId: claimed.clientId,
        cwd: claimed.cwd,
        instructions,
        userInfo: platformPrompt.userInfo,
        userInfoEpoch: platformPrompt.userInfoEpoch ?? undefined,
        agentProfileSnapshot: platformPrompt.agentProfileSnapshot ?? undefined,
        memorySnapshot: platformPrompt.memorySnapshot ?? undefined,
        todoUpdate: platformPrompt.todoUpdate,
        automationTrigger: automationTriggerForWake(
          claimed.origin,
          claimed.content,
          claimed.automationTrigger
        ),
        resetSelfSummaryCount: wakeResetsSelfSummaryCount(claimed.inboxType),
        requestSource: runtimeRequestSourceForOrigin(claimed.origin),
        channelId: claimed.channelId,
        deliveryId: claimed.deliveryId,
        runtimeProfile: claimed.runtimeProfile,
        subagentType: claimed.subagentType ?? undefined,
        fileAttachments: claimed.fileAttachments,
        dynamicNamespaces: pluginContext.dynamicNamespaces,
      } satisfies ComputerTurnRequest;
      const response = await fetch(`${this.computerUrl}${COMPUTER_API_PATHS.turns}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(turnRequest),
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
          const event = parseComputerEvent(JSON.parse(line));
          await this.projection.apply(claimed.runId, claimed.conversationId, claimed.botId, event);
          // Only approval and completion transitions can enqueue a push. Token
          // deltas are frequent and previously caused two empty outbox scans
          // per NDJSON event; the 2s safety timer still covers every other path.
          if (computerEventQueuesPushNotification(event)) {
            void this.pushNotifications
              .drain()
              .catch((error) => console.error("push notification delivery", error));
          }
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
      if (current && !priorityInterrupted) {
        const [bot, channel] = await Promise.all([
          tx.bot.findUnique({ where: { id: current.botId } }),
          tx.channel.findFirst({
            where: {
              kind: "bot_dm",
              archivedAt: null,
              members: { some: { botId: current.botId } },
            },
          }),
        ]);
        const lastMessage = channel
          ? await tx.channelMessage.findFirst({
              where: {
                channelId: channel.id,
                sourceRunId: claimed.runId,
                sender: "agent",
                senderBotId: current.botId,
              },
              orderBy: { sequence: "desc" },
            })
          : null;
        if (
          channel &&
          !lastMessage &&
          current.status !== "cancelled" &&
          runOwesUserDelivery(claimed.origin) &&
          claimed.inboxType !== "ack.redrive"
        ) {
          await this.messaging.enqueueWake(tx, {
            botId: current.botId,
            channelId: channel.id,
            origin: "handoff_resume",
            type: "ack.redrive",
            content: SEND_TO_USER_REPLY_NUDGE_PROMPT,
            clientId: `ack-redrive:${claimed.runId}`,
            priority: PRIORITY.agent,
            wrapUserContent: false,
          });
        }
        if (
          bot?.notificationsEnabled &&
          !bot.hiddenFromSidebar &&
          channel?.kind === "bot_dm" &&
          !channel.archivedAt &&
          lastMessage
        ) {
          const inputReason = notificationMessageInputReason(lastMessage);
          const kind = inputReason ? "agent-needs-input" : "agent-done";
          const presentation = agentNotificationPresentation({
            kind,
            botName: bot.name,
            body: inputReason ?? notificationMessagePreview(lastMessage),
          });
          await enqueuePushNotification(
            tx,
            inputReason
              ? `notification:needs-input:message:${claimed.runId}`
              : `notification:done:${claimed.runId}`,
            {
              schemaVersion: 1,
              kind,
              botId: bot.id,
              channelId: channel.id,
              runId: claimed.runId,
              title: presentation.title,
              body: presentation.body,
              deepLink: `openbot:///chat/${channel.id}`,
            }
          );
        }
      }
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
      subagentType: string;
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
      origin: "background_revival",
      type: `subagent.${status}`,
      content: renderSubagentRevivalPrompt({
        title: subagent.description,
        subagentType: subagent.subagentType,
        status,
        result,
      }),
      clientId: `subagent:${subagent.id}:${status}:${subagent.currentRunId}`,
      priority: 260,
      wrapUserContent: false,
    });
  }
}
