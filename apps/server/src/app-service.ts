import { resolve } from "node:path";
import {
  ApiError,
  type ComputerHandoffMutationInput,
  type CreateBotInput,
  type CreateGroupInput,
  type DynamicToolCallRequest,
  type InferenceProviderAuthSessionView,
  type ReactToChannelMessageInput,
  type RenameChannelInput,
  type ScreenActionInput,
  serverInferenceSettings,
  type ServerInferenceSettings,
  type ServerSettingsView,
  type SecretSubmissionInput,
  type SendMessageInput,
  type SetChannelAvatarInput,
  type SetChannelHiddenInput,
  type SetChannelMembersInput,
  type UpdateBotInput,
  type UpdateChannelProfileInput,
  type UploadAssetInput,
  type WidgetDismissInput,
  type WidgetResponseInput,
} from "@openteam/contracts";
import { createPrismaClient, Prisma, type PrismaClient } from "@openteam/db";
import {
  AgentDataStore,
  AgentMessaging,
  AssetStore,
  appendAgentTimelineEvent,
  type RoutineMutationInput,
  RoutineService,
  renderSubagentRevivalPrompt,
} from "@openteam/messaging";
import { Effect } from "effect";
import { PgBoss } from "pg-boss";
import { EventWakeup } from "./event-wakeup";
import { AdministrationService } from "./services/administration-service";
import {
  expirePendingApprovalsAfterRestart,
  expireTimedOutApprovals,
} from "./services/approval-lifecycle";
import { type AutoReviewInput, AutoReviewService } from "./services/auto-review-service";
import { BotService } from "./services/bot-service";
import { ChannelService } from "./services/channel-service";
import { InternalToolService } from "./services/internal-tool-service";
import { NotificationService } from "./services/notification-service";
import { PluginService } from "./services/plugin-service";
import { RichMessageService } from "./services/rich-message-service";
import { RunService } from "./services/run-service";
import { ScreenService } from "./services/screen-service";
import { SearchService } from "./services/search-service";
import { appendEvent } from "./services/service-utils";
import { SnapshotService } from "./services/snapshot-service";
import { SUBAGENT_RECOVERY_RUN_STATUSES, subagentRestartError } from "./services/subagent/recovery";
import { SubagentService } from "./services/subagent/service";
import { TodoService } from "./services/todo-service";
import { DurableStateService } from "./update-state";

const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";
const ASSET_ID = /^[a-f0-9]{64}$/;

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
  readonly richMessages: RichMessageService;
  readonly autoReview: AutoReviewService;
  readonly runs: RunService;
  readonly screens: ScreenService;
  readonly searchIndex: SearchService;
  readonly snapshots: SnapshotService;
  readonly assets: AssetStore;
  readonly notifications: NotificationService;
  readonly eventWakeup: EventWakeup;
  private queueReady = false;
  private approvalExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private eventPruneTimer: ReturnType<typeof setInterval> | null = null;
  private assetCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    authMode: import("./services/notification-service").PushAuthenticationMode = "required"
  ) {
    const databaseUrl = process.env.DATABASE_URL;
    this.prisma = createPrismaClient(databaseUrl);
    this.boss = new PgBoss(databaseUrl ?? "");
    this.eventWakeup = new EventWakeup(databaseUrl ?? "");
    this.computerUrl = process.env.OPENTEAM_COMPUTER_URL ?? "http://127.0.0.1:8790";
    this.controlToken = process.env.OPENTEAM_CONTROL_TOKEN ?? "local-compose-only-change-me";
    this.workspaceRoot = resolve(process.env.OPENTEAM_WORKSPACE_ROOT ?? "/workspace");
    this.screenViewerHost = process.env.OPENTEAM_SCREEN_VIEWER_HOST ?? "127.0.0.1";
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
    this.assets = new AssetStore({
      root: this.agentData.assetRoot,
      allowedFileRoots: [this.workspaceRoot, this.agentData.root],
    });
    this.notifications = new NotificationService(this.prisma, authMode);
    this.messaging = new AgentMessaging(this.prisma, this.boss, this.agentData, this.assets);
    this.agentData.setTimelineEventSink((tx, input) =>
      appendAgentTimelineEvent(tx, this.messaging, input)
    );
    this.bots = new BotService(
      this.prisma,
      this.boss,
      this.workspaceRoot,
      (path, init) => this.computerFetch(path, init),
      this.agentData,
      this.messaging
    );
    this.snapshots = new SnapshotService(
      this.prisma,
      this.workspaceRoot,
      this.computerUrl,
      () => this.queueReady,
      2_500,
      () => this.agentData.loadInferenceSettings()
    );
    this.channels = new ChannelService(
      this.prisma,
      this.messaging,
      this.workspaceRoot,
      (path, init) => this.computerFetch(path, init),
      this.agentData,
      this.assets
    );
    this.plugins = new PluginService(
      this.prisma,
      (path, init) => this.computerFetch(path, init ?? {}),
      this.agentData
    );
    this.richMessages = new RichMessageService(
      this.prisma,
      this.messaging,
      this.plugins,
      this.screens
    );
    this.autoReview = new AutoReviewService(
      (path, init) => this.computerFetch(path, init),
      () => this.agentData.loadInferenceSettings()
    );
    this.runs = new RunService(
      this.prisma,
      (path, init) => this.computerFetch(path, init),
      (callId, decision) => this.plugins.resolveInvocation(callId, decision),
      (details, decision) => this.plugins.resolveAction(details, decision),
      (connectionId, botId, toolName) =>
        Effect.runPromise(
          this.plugins.setPolicy(connectionId, { botId, toolName, decision: "allow" })
        )
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
      (path, init) => this.computerFetch(path, init),
      this.agentData
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
      this.agentData,
      this.messaging
    );
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
        await this.eventWakeup.start();
        await this.snapshots.pruneEvents();
        this.eventPruneTimer = setInterval(() => {
          void this.snapshots
            .pruneEvents()
            .catch((error) => console.error("event retention", error));
        }, 5 * 60_000);
        this.eventPruneTimer.unref?.();
        await this.agentData.startWatching();
        await this.plugins.syncFileCaches();
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
        // Asset pruning can scan a large history and filesystem. Keep the
        // lifecycle behavior without extending the server's critical startup path.
        queueMicrotask(() => {
          void this.pruneUnreferencedAssets().catch((error) =>
            console.error("asset cleanup", error)
          );
        });
        this.assetCleanupTimer = setInterval(
          () => {
            void this.pruneUnreferencedAssets().catch((error) =>
              console.error("asset cleanup", error)
            );
          },
          6 * 60 * 60_000
        );
        this.assetCleanupTimer.unref?.();
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
      if (this.eventPruneTimer) {
        clearInterval(this.eventPruneTimer);
        this.eventPruneTimer = null;
      }
      if (this.assetCleanupTimer) {
        clearInterval(this.assetCleanupTimer);
        this.assetCleanupTimer = null;
      }
      await this.eventWakeup.stop();
      await this.agentData.stopWatching();
      await this.boss.stop({ graceful: true });
      await this.plugins.close();
      await this.prisma.$disconnect();
    });

  private async pruneUnreferencedAssets(): Promise<void> {
    // Extract only candidate ids in PostgreSQL. Pulling every message's complete
    // JSON metadata into Bun made the six-hour cleanup proportional to total
    // transcript bytes and could briefly duplicate a very large history in RAM.
    const candidates = await this.prisma.$queryRaw<Array<{ assetId: string | null }>>(Prisma.sql`
      SELECT DISTINCT candidate #>> '{}' AS "assetId"
      FROM "ChannelMessage" AS message
      CROSS JOIN LATERAL jsonb_path_query(
        coalesce(message."metadata", '{}'::jsonb),
        '$.**.assetId'::jsonpath
      ) AS candidate
      WHERE jsonb_typeof(candidate) = 'string'
    `);
    const referenced = new Set(
      candidates.flatMap(({ assetId }) => (assetId && ASSET_ID.test(assetId) ? [assetId] : []))
    );
    await this.assets.prune(referenced);
  }

  createBot = (input: CreateBotInput) => this.bots.create(input);

  broadcast = (input: import("@openteam/contracts").AdminBroadcastInput) =>
    Effect.tryPromise({
      try: () => this.messaging.broadcast(input),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  listBots = (includeHidden = false) => this.bots.list(includeHidden);

  updateBot = (botId: string, input: UpdateBotInput) => this.bots.update(botId, input);

  retryBotProvisioning = (botId: string) => this.bots.retryProvisioning(botId);

  botTranscript = (botId: string) => this.bots.transcript(botId);

  listRoutines = (botId: string) =>
    Effect.tryPromise({
      try: () => this.routines.list(botId),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  listGroupRoutines = (channelId: string) =>
    Effect.tryPromise({
      try: () => this.routines.listOwner({ kind: "group", id: channelId }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  routineDetail = (routineId: string) =>
    Effect.tryPromise({
      try: async () => this.routines.detailOwner(await this.routines.owner(routineId), routineId),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  createGroupRoutine = (channelId: string, clientId: string, input: RoutineMutationInput) =>
    Effect.tryPromise({
      try: async () => {
        const owner = { kind: "group" as const, id: channelId };
        const created = await this.routines.mutateOwner(owner, clientId, null, {
          ...input,
          action: "create",
          source: "ui",
        });
        return this.routines.detailOwner(owner, String(created.id));
      },
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
        const owner = await this.routines.owner(routineId);
        await this.routines.mutateOwner(owner, clientId, null, {
          ...input,
          id: routineId,
          action: "update",
          source: "ui",
        });
        return this.routines.detailOwner(owner, routineId);
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
        const owner = await this.routines.owner(routineId);
        const result = await this.routines.mutateOwner(owner, clientId, null, {
          id: routineId,
          action,
          expectedRevision,
          source: "ui",
        });
        return action === "delete" ? result : this.routines.detailOwner(owner, routineId);
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  runRoutineNow = (routineId: string, clientId: string) =>
    Effect.tryPromise({
      try: async () =>
        this.routines.runNowOwner(await this.routines.owner(routineId), routineId, clientId),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  routineExecutions = (routineId: string, limit: number) =>
    Effect.tryPromise({
      try: async () =>
        this.routines.executionsOwner(await this.routines.owner(routineId), routineId, limit),
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

  messageDeliveryStatus = (channelId: string, clientId: string) =>
    this.channels.messageDeliveryStatus(channelId, clientId);

  createGroup = (input: CreateGroupInput) => this.channels.createGroup(input);

  listGroups = (includeHidden = false) => this.channels.listGroups(includeHidden);

  renameChannel = (channelId: string, input: RenameChannelInput) =>
    this.channels.renameDirectChannel(channelId, input);

  updateChannelProfile = (channelId: string, input: UpdateChannelProfileInput) =>
    this.channels.updateGroupProfile(channelId, input);

  setChannelAvatar = (channelId: string, input: SetChannelAvatarInput) =>
    this.channels.setGroupAvatar(channelId, input);

  channelAvatar = (channelId: string) => this.channels.groupAvatar(channelId);

  setChannelMembers = (channelId: string, input: SetChannelMembersInput) =>
    this.channels.setGroupMembers(channelId, input);

  setChannelHidden = (channelId: string, input: SetChannelHiddenInput) =>
    this.channels.setGroupHidden(channelId, input);

  deleteGroup = (channelId: string) => this.channels.deleteGroup(channelId);

  sendChannelMessage = (channelId: string, input: SendMessageInput) =>
    this.channels.sendGroupMessage(channelId, input);

  reactToMessage = (messageId: string, input: ReactToChannelMessageInput) =>
    this.channels.reactToMessage(messageId, input);

  respondToWidget = (messageId: string, input: WidgetResponseInput) =>
    this.richMessages.respondToWidget(messageId, input);

  dismissWidget = (messageId: string, input: WidgetDismissInput) =>
    this.richMessages.dismissWidget(messageId, input);

  submitSecret = (messageId: string, input: SecretSubmissionInput) =>
    this.richMessages.submitSecret(messageId, input);

  mutateComputerHandoff = (messageId: string, input: ComputerHandoffMutationInput) =>
    this.richMessages.mutateComputerHandoff(messageId, input);

  handleDynamicTool = (request: DynamicToolCallRequest) => this.internalTools.execute(request);

  pluginSettings = () => this.plugins.settings();

  pluginConnectionStatuses = (connectionIds: readonly string[]) =>
    this.plugins.pollConnectionStatuses(connectionIds);

  pluginBotAccess = (pluginKey: string, query: string, offset: number, limit: number) =>
    this.plugins.botAccess(pluginKey, query, offset, limit);

  rootSettings = () =>
    Effect.tryPromise({
      try: () => this.agentData.loadRootSettingsForClient(),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  serverSettings = (providerId?: string) =>
    Effect.tryPromise({
      try: async (): Promise<ServerSettingsView> => {
        const inference = await this.agentData.loadInferenceSettings();
        const selectedProvider = providerId ?? inference.providerId;
        const query = new URLSearchParams({ provider: selectedProvider });
        const catalog = await this.computerJson<
          Pick<ServerSettingsView, "providers" | "models" | "modelProviderId">
        >(`/v1/inference/providers?${query}`, { method: "GET" });
        return { inference, ...catalog };
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  updateInferenceSettings = (input: unknown) =>
    Effect.tryPromise({
      try: async (): Promise<ServerInferenceSettings> => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new ApiError(400, "invalid_inference_settings", "Inference settings are required");
        }
        const value = input as Record<string, unknown>;
        if (typeof value.providerId !== "string" || typeof value.modelId !== "string") {
          throw new ApiError(
            400,
            "invalid_inference_settings",
            "providerId, modelId, and reasoning are required"
          );
        }
        let settings: ServerInferenceSettings;
        try {
          settings = serverInferenceSettings(value.providerId, value.modelId, value.reasoning);
        } catch (error) {
          throw new ApiError(
            400,
            "invalid_inference_settings",
            error instanceof Error ? error.message : String(error)
          );
        }
        await this.computerJson("/v1/inference/settings/verify", {
          method: "POST",
          body: JSON.stringify(settings),
        });
        return this.agentData.writeInferenceSettings(settings);
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  startInferenceProviderAuth = (providerId: string, authType: "api_key" | "oauth") =>
    Effect.tryPromise({
      try: () =>
        this.computerJson<InferenceProviderAuthSessionView>(
          `/v1/inference/providers/${encodeURIComponent(providerId)}/auth-sessions`,
          { method: "POST", body: JSON.stringify({ authType }) }
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  inferenceProviderAuthSession = (sessionId: string) =>
    Effect.tryPromise({
      try: () =>
        this.computerJson<InferenceProviderAuthSessionView>(
          `/v1/inference/auth-sessions/${encodeURIComponent(sessionId)}`,
          { method: "GET" }
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  respondToInferenceProviderAuth = (sessionId: string, promptId: string, value: string) =>
    Effect.tryPromise({
      try: () =>
        this.computerJson<InferenceProviderAuthSessionView>(
          `/v1/inference/auth-sessions/${encodeURIComponent(sessionId)}/respond`,
          { method: "POST", body: JSON.stringify({ promptId, value }) }
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  cancelInferenceProviderAuth = (sessionId: string) =>
    Effect.tryPromise({
      try: () =>
        this.computerJson(`/v1/inference/auth-sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  disconnectInferenceProvider = (providerId: string) =>
    Effect.tryPromise({
      try: () =>
        this.computerJson(`/v1/inference/providers/${encodeURIComponent(providerId)}`, {
          method: "DELETE",
        }),
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

  installPlugin = (pluginKey: string, values?: Record<string, string>) =>
    this.plugins.install(pluginKey, values);

  addCustomMcp = (input: import("@openteam/contracts").AddCustomMcpInput) =>
    this.plugins.addCustomMcp(input);

  uninstallPlugin = (pluginKey: string) => this.plugins.uninstall(pluginKey);

  connectPlugin = (connectionId: string) => this.plugins.connect(connectionId);

  disconnectPlugin = (connectionId: string) => this.plugins.disconnect(connectionId);

  addPluginAccount = (connectionId: string, alias: string) =>
    this.plugins.addAccount(connectionId, alias);

  configurePluginConnection = (
    connectionId: string,
    input: import("@openteam/contracts").ConfigurePluginConnectionInput
  ) => this.plugins.configure(connectionId, input);

  authenticatePlugin = (connectionId: string, force = false) =>
    this.plugins.authenticate(connectionId, force);

  finishPluginAuthentication = (connectionId: string, code: string, state: string) =>
    this.plugins.finishAuthentication(connectionId, code, state);

  restartPluginConnection = (connectionId: string) => this.plugins.restart(connectionId);

  renamePluginAccount = (connectionId: string, alias: string) =>
    this.plugins.renameAccount(connectionId, alias);

  removePluginAccount = (connectionId: string) => this.plugins.removeAccount(connectionId);

  setMcpInstructions = (connectionId: string, instructions: string) =>
    this.plugins.setInstructions(connectionId, instructions);

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
    input: import("@openteam/contracts").SetPluginToolPolicyInput
  ) => this.plugins.setPolicy(connectionId, input);

  cancelRun = (runId: string) => this.runs.cancel(runId);

  resolveApproval = (
    approvalId: string,
    decision: import("@openteam/contracts").ApprovalDecision
  ) => this.runs.resolveApproval(approvalId, decision);

  snapshot = () => this.snapshots.full();

  clientSnapshot = () => this.snapshots.client();

  clientBootstrap = () => this.snapshots.bootstrap();

  channelHistory = (channelId: string, beforeSequence: bigint | null, limit: number) =>
    this.snapshots.history(channelId, beforeSequence, limit);

  channelMessageContext = (messageId: string, before: number, after: number) =>
    this.snapshots.messageContext(messageId, before, after);

  channelClientState = (channelId: string) => this.snapshots.channelState(channelId);

  clientRuntime = () => this.snapshots.clientRuntime();

  uploadAsset = (input: UploadAssetInput) =>
    Effect.tryPromise({
      try: () => this.assets.decodeUpload(input),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  uploadBinaryAsset = (
    stream: ReadableStream<Uint8Array>,
    contentType: string,
    fileName: string | null,
    signal?: AbortSignal
  ) =>
    Effect.tryPromise({
      try: () =>
        this.assets.ingestStream({
          stream,
          mimeType: contentType,
          fileName: fileName ?? "attachment",
          signal,
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  registerPushDevice = (
    input: import("@openteam/contracts").RegisterPushDeviceInput,
    authentication: import("./services/notification-service").PushRegistrationAuthentication
  ) => this.notifications.register(input, authentication);

  unregisterPushDevice = (installationId: string) => this.notifications.unregister(installationId);

  disablePushDevicesForSession = (sessionId: string) =>
    this.notifications.disableForSession(sessionId);

  markChannelRead = (channelId: string, throughSequence?: string) =>
    this.notifications.markChannelRead(channelId, throughSequence);

  reviewPermission = (input: AutoReviewInput) =>
    Effect.tryPromise({
      try: () => this.autoReview.review(input),
      catch: (error) => error as Error,
    });

  search = (query: string, category: import("@openteam/contracts").SearchCategory) =>
    this.searchIndex.search(query, category);

  health = () => this.snapshots.health();

  eventsAfter = (sequence: bigint) => this.snapshots.eventsAfter(sequence);

  eventWindowAfter = (sequence: bigint, limit?: number) =>
    this.snapshots.eventWindowAfter(sequence, limit);

  waitForEvent = (version: number, timeoutMs: number, signal?: AbortSignal) =>
    this.eventWakeup.wait(version, timeoutMs, signal);

  get eventVersion() {
    return this.eventWakeup.currentVersion;
  }

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
              origin: "background_revival",
              type: "subagent.failed",
              content: renderSubagentRevivalPrompt({
                title: attempt.description,
                subagentType: subagent.subagentType,
                status: "failed",
                result: error.message,
              }),
              clientId: `subagent:${subagent.id}:failed:${subagent.currentRunId}`,
              priority: 260,
              wrapUserContent: false,
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

  private async computerJson<T = { ok: true }>(path: string, init: RequestInit): Promise<T> {
    const response = await this.computerFetch(path, init);
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // Preserve a non-JSON computer error as-is.
      }
      throw new ApiError(
        response.status >= 500 ? 503 : 400,
        "inference_provider_error",
        message || "The inference provider operation failed"
      );
    }
    return (await response.json()) as T;
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
