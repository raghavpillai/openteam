import { resolve } from "node:path";
import {
  ApiError,
  type CreateBotInput,
  type CreateGroupInput,
  type DynamicToolCallRequest,
  type ReactToChannelMessageInput,
  type RenameChannelInput,
  type ScreenActionInput,
  type SendMessageInput,
  type SetChannelMembersInput,
  type UpdateBotInput,
} from "@openbot/contracts";
import { createPrismaClient, type PrismaClient } from "@openbot/db";
import {
  AgentDataStore,
  AgentMessaging,
  type RoutineMutationInput,
  RoutineService,
} from "@openbot/messaging";
import { Effect } from "effect";
import { PgBoss } from "pg-boss";
import { AdministrationService } from "./services/administration-service";
import {
  expirePendingApprovalsAfterRestart,
  expireTimedOutApprovals,
} from "./services/approval-lifecycle";
import { BotService } from "./services/bot-service";
import { ChannelService } from "./services/channel-service";
import { InternalToolService } from "./services/internal-tool-service";
import { PluginService } from "./services/plugin-service";
import { RunService } from "./services/run-service";
import { ScreenService } from "./services/screen-service";
import { SearchService } from "./services/search-service";
import { appendEvent } from "./services/service-utils";
import { SnapshotService } from "./services/snapshot-service";
import { SUBAGENT_RECOVERY_RUN_STATUSES, subagentRestartError } from "./services/subagent-recovery";
import { SubagentService } from "./services/subagent-service";
import { TodoService } from "./services/todo-service";
import { DurableStateService } from "./update-state";

const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";
export class AppService {
  readonly prisma: PrismaClient;
  readonly boss: PgBoss;
  readonly computerUrl: string;
  readonly controlToken: string;
  readonly workspaceRoot: string;
  readonly screenViewerHost: string;
  readonly agentData: AgentDataStore;
  readonly messaging: AgentMessaging;
  readonly routines: RoutineService;
  readonly durableState: DurableStateService;
  readonly bots: BotService;
  readonly channels: ChannelService;
  readonly administration: AdministrationService;
  readonly subagents: SubagentService;
  readonly todos: TodoService;
  readonly internalTools: InternalToolService;
  readonly plugins: PluginService;
  readonly runs: RunService;
  readonly screens: ScreenService;
  readonly searchIndex: SearchService;
  readonly snapshots: SnapshotService;
  private queueReady = false;
  private approvalExpiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    this.prisma = createPrismaClient(databaseUrl);
    this.boss = new PgBoss(databaseUrl ?? "");
    this.computerUrl = process.env.OPENBOT_COMPUTER_URL ?? "http://127.0.0.1:8790";
    this.controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
    this.workspaceRoot = resolve(process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace");
    this.screenViewerHost = process.env.OPENBOT_SCREEN_VIEWER_HOST ?? "127.0.0.1";
    this.agentData = new AgentDataStore(this.prisma, {
      workspaceRoot: this.workspaceRoot,
    });
    this.screens = new ScreenService(
      this.prisma,
      this.agentData.root,
      this.screenViewerHost,
      (path, init) => this.computerFetch(path, init)
    );
    this.searchIndex = new SearchService(this.prisma);
    this.bots = new BotService(
      this.prisma,
      this.boss,
      this.workspaceRoot,
      (path, init) => this.computerFetch(path, init),
      this.agentData
    );
    this.snapshots = new SnapshotService(
      this.prisma,
      this.workspaceRoot,
      this.computerUrl,
      () => this.queueReady
    );
    this.messaging = new AgentMessaging(this.prisma, this.boss, this.agentData);
    this.channels = new ChannelService(
      this.prisma,
      this.messaging,
      this.workspaceRoot,
      (path, init) => this.computerFetch(path, init),
      this.agentData
    );
    this.runs = new RunService(this.prisma, (path, init) => this.computerFetch(path, init));
    this.todos = new TodoService(this.prisma);
    this.administration = new AdministrationService(
      this.prisma,
      this.bots,
      this.messaging,
      this.workspaceRoot,
      (path, init) => this.computerFetch(path, init),
      this.agentData
    );
    this.subagents = new SubagentService(
      this.prisma,
      this.messaging,
      this.runs,
      this.workspaceRoot,
      (path, init) => this.computerFetch(path, init)
    );
    this.routines = new RoutineService(this.prisma, this.messaging, this.agentData);
    this.durableState = new DurableStateService(
      this.prisma,
      this.workspaceRoot,
      async (project) => {
        const response = await this.computerFetch("/v1/projects", {
          method: "PUT",
          body: JSON.stringify(project),
        });
        if (!response.ok) {
          throw new ApiError(503, "computer_unavailable", await response.text());
        }
      },
      this.routines,
      this.agentData
    );
    this.plugins = new PluginService(this.prisma);
    this.internalTools = new InternalToolService(
      this.prisma,
      this.messaging,
      this.durableState,
      (runId) => this.channels.interruptNonUserRun(runId),
      this.todos,
      this.subagents,
      this.administration,
      this.plugins
    );
    this.boss.on("error", (error) => console.error("pg-boss", error));
  }

  boot = () =>
    Effect.tryPromise({
      try: async () => {
        await this.prisma.$queryRaw`SELECT 1`;
        await this.agentData.startWatching();
        await this.boss.start();
        await this.boss.createQueue("bot-wake");
        await this.boss.createQueue("bot-provision");
        await this.boss.createQueue("transcript-project");
        await this.boss.createQueue("outbox-delivery");
        await this.boss.createQueue("maintenance");
        this.queueReady = true;
        await this.recover();
        this.approvalExpiryTimer = setInterval(() => {
          void this.expirePendingApprovals().catch((error) =>
            console.error("approval expiry", error)
          );
        }, 60_000);
        this.approvalExpiryTimer.unref?.();
        const groups = await this.prisma.channel.findMany({
          where: { kind: "group", archivedAt: null },
          select: { workingDirectory: true },
        });
        await this.provisionDirectories([
          resolve(this.workspaceRoot, "bots"),
          resolve(this.workspaceRoot, "projects"),
          resolve(this.workspaceRoot, "shared"),
          ...groups.flatMap((group) => (group.workingDirectory ? [group.workingDirectory] : [])),
        ]);
        await this.prisma.computer.upsert({
          where: { id: COMPUTER_ID },
          create: {
            id: COMPUTER_ID,
            status: "starting",
            capabilities: {
              headless: false,
              graphical: true,
              browser: "chromium",
              fileManager: "thunar",
            },
          },
          update: {
            capabilities: {
              headless: false,
              graphical: true,
              browser: "chromium",
              fileManager: "thunar",
            },
          },
        });
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  close = () =>
    Effect.promise(async () => {
      if (this.approvalExpiryTimer) {
        clearInterval(this.approvalExpiryTimer);
        this.approvalExpiryTimer = null;
      }
      await this.agentData.stopWatching();
      await this.boss.stop({ graceful: true });
      await this.prisma.$disconnect();
    });

  createBot = (input: CreateBotInput) => this.bots.create(input);

  updateBot = (botId: string, input: UpdateBotInput) => this.bots.update(botId, input);

  retryBotProvisioning = (botId: string) => this.bots.retryProvisioning(botId);

  botTranscript = (botId: string) => this.bots.transcript(botId);

  listRoutines = (botId: string) =>
    Effect.tryPromise({
      try: () => this.routines.list(botId),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  routineDetail = (routineId: string) =>
    Effect.tryPromise({
      try: async () => this.routines.detail(await this.routines.ownerId(routineId), routineId),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  createRoutine = (botId: string, clientId: string, input: RoutineMutationInput) =>
    Effect.tryPromise({
      try: async () => {
        const created = await this.routines.mutate(botId, clientId, null, {
          ...input,
          action: "create",
          source: "ui",
        });
        return this.routines.detail(botId, String(created.id));
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  updateRoutine = (routineId: string, clientId: string, input: RoutineMutationInput) =>
    Effect.tryPromise({
      try: async () => {
        const botId = await this.routines.ownerId(routineId);
        await this.routines.mutate(botId, clientId, null, {
          ...input,
          id: routineId,
          action: "update",
          source: "ui",
        });
        return this.routines.detail(botId, routineId);
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  routineLifecycle = (
    routineId: string,
    clientId: string,
    action: "pause" | "resume" | "delete",
    expectedRevision?: number
  ) =>
    Effect.tryPromise({
      try: async () => {
        const botId = await this.routines.ownerId(routineId);
        const result = await this.routines.mutate(botId, clientId, null, {
          id: routineId,
          action,
          expectedRevision,
          source: "ui",
        });
        return action === "delete" ? result : this.routines.detail(botId, routineId);
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  runRoutineNow = (routineId: string, clientId: string) =>
    Effect.tryPromise({
      try: async () =>
        this.routines.runNow(await this.routines.ownerId(routineId), routineId, clientId),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  routineExecutions = (routineId: string, limit: number) =>
    Effect.tryPromise({
      try: async () =>
        this.routines.executions(await this.routines.ownerId(routineId), routineId, limit),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  screenStatus = (botId: string) => this.screens.status(botId);

  screenFrame = (botId: string) => this.screens.frame(botId);

  botAvatar = (botId: string) => this.screens.avatar(botId);

  screenAction = (botId: string, input: ScreenActionInput) => this.screens.action(botId, input);

  screenTakeover = (botId: string, active: boolean) => this.screens.takeover(botId, active);

  screenPause = (botId: string, paused: boolean) => this.screens.pause(botId, paused);

  archiveBot = (botId: string) => this.bots.archive(botId);

  sendMessage = (conversationId: string, input: SendMessageInput) =>
    this.channels.sendDirectMessage(conversationId, input);

  createGroup = (input: CreateGroupInput) => this.channels.createGroup(input);

  renameChannel = (channelId: string, input: RenameChannelInput) =>
    this.channels.renameDirectChannel(channelId, input);

  setChannelMembers = (channelId: string, input: SetChannelMembersInput) =>
    this.channels.setGroupMembers(channelId, input);

  sendChannelMessage = (channelId: string, input: SendMessageInput) =>
    this.channels.sendGroupMessage(channelId, input);

  reactToMessage = (messageId: string, input: ReactToChannelMessageInput) =>
    this.channels.reactToMessage(messageId, input);

  handleDynamicTool = (request: DynamicToolCallRequest) => this.internalTools.execute(request);

  pluginSettings = () => this.plugins.settings();

  rootSettings = () =>
    Effect.tryPromise({
      try: () => this.agentData.loadRootSettings(),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  updateSidebarPreferences = (input: unknown) =>
    Effect.tryPromise({
      try: () => this.agentData.writeSidebarPreferences(input),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  activeAgent = () =>
    Effect.tryPromise({
      try: () => this.agentData.loadActiveAgentId(),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  setActiveAgent = (activeAgentId: string) =>
    Effect.tryPromise({
      try: async () => {
        await this.agentData.writeActiveAgentId(activeAgentId);
        return { activeAgentId };
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  installPlugin = (pluginKey: string) => this.plugins.install(pluginKey);

  addCustomMcp = (name: string, url: string, alias?: string) =>
    this.plugins.addCustomMcp(name, url, alias);

  uninstallPlugin = (pluginKey: string) => this.plugins.uninstall(pluginKey);

  connectPlugin = (connectionId: string) => this.plugins.connect(connectionId);

  disconnectPlugin = (connectionId: string) => this.plugins.disconnect(connectionId);

  addPluginAccount = (connectionId: string, alias: string) =>
    this.plugins.addAccount(connectionId, alias);

  setPluginGrant = (connectionId: string, botId: string, enabled: boolean) =>
    this.plugins.setGrant(connectionId, botId, enabled);

  setPluginEnablement = (
    pluginKey: string,
    botId: string,
    enabled: boolean,
    skillsEnabled?: boolean
  ) => this.plugins.setEnablement(pluginKey, botId, enabled, skillsEnabled);

  setPluginPolicy = (
    connectionId: string,
    input: import("@openbot/contracts").SetPluginToolPolicyInput
  ) => this.plugins.setPolicy(connectionId, input);

  cancelRun = (runId: string) => this.runs.cancel(runId);

  resolveApproval = (approvalId: string, decision: "accept" | "decline" | "cancel") =>
    this.runs.resolveApproval(approvalId, decision);

  snapshot = () => this.snapshots.full();

  clientSnapshot = () => this.snapshots.client();

  search = (query: string, category: import("@openbot/contracts").SearchCategory) =>
    this.searchIndex.search(query, category);

  health = () => this.snapshots.health();

  eventsAfter = (sequence: bigint) => this.snapshots.eventsAfter(sequence);

  private async recover(): Promise<void> {
    const now = new Date();
    const archivedParentChildren = await this.prisma.subagent.findMany({
      where: { parentBot: { status: "archived" } },
      select: {
        id: true,
        parentBotId: true,
        childBotId: true,
        currentRunId: true,
        status: true,
      },
    });
    await this.prisma.$transaction(async (tx) => {
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
      const interrupted = await tx.run.updateMany({
        where: { status: { in: ["running", "waiting_approval"] } },
        data: {
          status: "interrupted",
          completedAt: now,
          error: {
            code: "runtime_restart",
            message: "Runtime restarted during this turn",
          },
        },
      });
      await expirePendingApprovalsAfterRestart(tx, now);
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
        if ((attempt?.runInBackground ?? subagent.runInBackground) && attempt) {
          const parent = await tx.bot.findUnique({
            where: { id: subagent.parentBotId },
            select: { status: true },
          });
          if (parent && ["active", "provisioning"].includes(parent.status)) {
            await this.messaging.enqueueWake(tx, {
              botId: subagent.parentBotId,
              channelId: attempt.parentChannelId,
              origin: "agent",
              type: "subagent.failed",
              content: [
                "[Background subagent failed]",
                `Agent ID: ${subagent.id}`,
                `Task: ${attempt.description}`,
                `Transcript: ${subagent.outputPath}`,
                "",
                error.message,
              ].join("\n"),
              clientId: `subagent:${subagent.id}:failed:${subagent.currentRunId}`,
              priority: 260,
            });
          }
        }
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
              status: { in: ["queued", "running", "waiting_approval", "interrupted"] },
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
          await tx.approval.updateMany({
            where: { runId: child.currentRunId, status: "pending" },
            data: { status: "expired", resolvedAt: now },
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
          deliveryMode: "turn",
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
        this.computerFetch(`/v1/screens/${child.childBotId}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined)
      )
    );
    const provisioningBots = await this.prisma.bot.findMany({
      where: { status: "provisioning" },
      select: { id: true },
    });
    for (const { id: botId } of provisioningBots) {
      await this.boss.send(
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
    const pendingBootstraps = await this.prisma.bot.findMany({
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
      await this.prisma.$transaction((tx) =>
        this.messaging.enqueueBootstrap(tx, bot.id, channelId)
      );
    }
    const pendingBots = await this.prisma.inboxEvent.findMany({
      where: {
        deliveryMode: "turn",
        status: "pending",
        availableAt: { lte: now },
        bot: { status: "active" },
      },
      distinct: ["botId"],
      select: { botId: true },
    });
    for (const { botId } of pendingBots) {
      await this.boss.send(
        "bot-wake",
        { botId },
        { retryLimit: 5, retryDelay: 2, retryBackoff: true }
      );
    }
    await this.messaging.recoverRounds();
  }

  private async expirePendingApprovals(): Promise<void> {
    await expireTimedOutApprovals(this.prisma, new Date());
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

  private async provisionDirectories(paths: string[]): Promise<void> {
    const response = await this.computerFetch("/v1/directories", {
      method: "PUT",
      body: JSON.stringify({ paths }),
    });
    if (!response.ok) {
      throw new ApiError(503, "computer_unavailable", await response.text());
    }
  }
}
