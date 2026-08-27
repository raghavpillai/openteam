import { resolve } from "node:path";
import {
  ApiError,
  type CreateBotInput,
  type CreateGroupInput,
  type DynamicToolCallRequest,
  type ReactToChannelMessageInput,
  type ScreenActionInput,
  type SendMessageInput,
  type UpdateBotInput,
} from "@openbot/contracts";
import { createPrismaClient, type PrismaClient } from "@openbot/db";
import { AgentDataStore, AgentMessaging, RoutineService } from "@openbot/messaging";
import { Effect } from "effect";
import { PgBoss } from "pg-boss";
import { AdministrationService } from "./services/administration-service";
import { BotService } from "./services/bot-service";
import { ChannelService } from "./services/channel-service";
import { InternalToolService } from "./services/internal-tool-service";
import { PluginService } from "./services/plugin-service";
import { RunService } from "./services/run-service";
import { ScreenService } from "./services/screen-service";
import { SearchService } from "./services/search-service";
import { appendEvent } from "./services/service-utils";
import { SnapshotService } from "./services/snapshot-service";
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
    this.runs = new RunService(this.prisma, this.messaging, (path, init) =>
      this.computerFetch(path, init)
    );
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
      await this.agentData.stopWatching();
      await this.boss.stop({ graceful: true });
      await this.prisma.$disconnect();
    });

  createBot = (input: CreateBotInput) => this.bots.create(input);

  updateBot = (botId: string, input: UpdateBotInput) => this.bots.update(botId, input);

  retryBotProvisioning = (botId: string) => this.bots.retryProvisioning(botId);

  botTranscript = (botId: string) => this.bots.transcript(botId);

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

  compactConversation = (conversationId: string) => this.runs.compactConversation(conversationId);

  snapshot = () => this.snapshots.full();

  clientSnapshot = () => this.snapshots.client();

  search = (query: string, category: import("@openbot/contracts").SearchCategory) =>
    this.searchIndex.search(query, category);

  health = () => this.snapshots.health();

  eventsAfter = (sequence: bigint) => this.snapshots.eventsAfter(sequence);

  private async recover(): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
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
      await tx.approval.updateMany({
        where: {
          status: "pending",
          requestMethod: { not: "plugin/tool" },
        },
        data: { status: "expired", resolvedAt: now },
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
