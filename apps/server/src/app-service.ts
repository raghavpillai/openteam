import { MachineService } from "./services/machine-service";
import { AutomationWebhooksService } from "./services/automation-webhooks";
import { ApiError, type UploadAssetInput } from "@openteam/contracts";
import { createPrismaClient, Prisma, type PrismaClient } from "@openteam/db";
import {
  AgentDataStore,
  AgentMessaging,
  appendAgentTimelineEvent,
  AssetStore,
  type RoutineMutationInput,
  RoutineService,
} from "@openteam/messaging";
import { Effect } from "effect";
import { join, resolve } from "node:path";
import { TranscriptionService } from "./transcription/service";
import { TranscriptionStore } from "./transcription/store";
import { PgBoss } from "pg-boss";
import { EventWakeup } from "./event-wakeup";
import { AdministrationService } from "./services/administration-service";
import { expireTimedOutApprovals } from "./services/approval-lifecycle";
import { type AutoReviewInput, AutoReviewService } from "./services/auto-review-service";
import { loadAutoReviewContext } from "./services/auto-review-context";
import { BotService } from "./services/bot-service";
import { ChannelService } from "./services/channel-service";
import { InternalToolService } from "./services/internal-tool-service";
import { NotificationService } from "./services/notification-service";
import { PluginService } from "./services/plugin-service";
import { provisionDirectories } from "./services/provision-directories";
import { RichMessageService } from "./services/rich-message-service";
import { RunService } from "./services/run-service";
import { ScreenService } from "./services/screen-service";
import { SearchService } from "./services/search-service";
import { forwardServiceMethod, serviceEffect } from "./services/service-utils";
import { WebFetchSettingsService } from "./services/web-fetch-settings";
import { SavedLoginService } from "./services/saved-login-service";
import { ReviewPolicyService } from "./services/review-policy-service";
import { WebSearchSettingsService } from "./services/web-search-settings";
import { SettingsService } from "./services/settings-service";
import { SnapshotService } from "./services/snapshot-service";
import { recover } from "./services/startup-recovery";
import { SubagentService } from "./services/subagent/service";
import { TodoService } from "./services/todo-service";
import { DurableStateService } from "./update-state";

const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";

const ASSET_ID = /^[a-f0-9]{64}$/;

export class AppService {
  readonly transcription: TranscriptionService;
  readonly webSearchSettings: WebSearchSettingsService;
  readonly savedLogins: SavedLoginService;
  readonly reviewPolicy: ReviewPolicyService;
  readonly automationWebhooks: AutomationWebhooksService;
  readonly webFetchSettings: WebFetchSettingsService;
  private readonly settings: SettingsService;

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
  readonly machines: MachineService;
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
  private reviewRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  private approvalExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private eventPruneTimer: ReturnType<typeof setInterval> | null = null;
  private assetCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    authMode: import("./services/notification-service").PushAuthenticationMode = "required"
  ) {
    const databaseUrl = process.env.DATABASE_URL;
    this.prisma = createPrismaClient(databaseUrl);
    this.webSearchSettings = new WebSearchSettingsService(this.prisma);
    this.savedLogins = new SavedLoginService(this.prisma);
    this.machines = new MachineService(
      this.prisma,
      process.env.OPENTEAM_CONTROL_TOKEN ?? "local-compose-only-change-me",
      undefined,
      undefined,
      authMode === "disabled"
    );
    this.webFetchSettings = new WebFetchSettingsService(this.prisma);
    this.boss = new PgBoss(databaseUrl ?? "");
    this.eventWakeup = new EventWakeup(databaseUrl ?? "");
    this.computerUrl = process.env.OPENTEAM_COMPUTER_URL ?? "http://127.0.0.1:8790";
    this.controlToken = process.env.OPENTEAM_CONTROL_TOKEN ?? "local-compose-only-change-me";
    this.workspaceRoot = resolve(process.env.OPENTEAM_WORKSPACE_ROOT ?? "/workspace");
    this.screenViewerHost = process.env.OPENTEAM_SCREEN_VIEWER_HOST ?? "127.0.0.1";
    this.agentData = new AgentDataStore(this.prisma, {
      workspaceRoot: this.workspaceRoot,
    });
    this.transcription = new TranscriptionService(
      new TranscriptionStore(join(this.agentData.root, "transcription.json"))
    );
    this.screens = new ScreenService(
      this.prisma,
      this.agentData.root,
      this.screenViewerHost,
      (path, init) => this.computerFetch(path, init),
      this.computerUrl
    );
    this.searchIndex = new SearchService(this.prisma);
    this.assets = new AssetStore({
      root: this.agentData.assetRoot,
      agentDataRoot: this.agentData.root,
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
      async () => {
        if (!this.queueReady) return false;
        const result = await this.boss
          .getDb()
          .executeSql(
            "SELECT count(*)::int AS count FROM pgboss.queue WHERE name IN ('bot-wake','bot-provision','transcript-project','outbox-delivery','maintenance')"
          );
        return result.rows[0]?.count === 5;
      },
      2_500,
      () => this.agentData.loadInferenceSettings(),
      () => this.transcription.store.status()
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
      this.screens,
      this.bots
    );
    this.autoReview = new AutoReviewService(
      (path, init) => this.computerFetch(path, init),
      () => this.agentData.loadInferenceSettings(),
      (context) => loadAutoReviewContext(this.prisma, context)
    );
    this.reviewPolicy = new ReviewPolicyService(this.prisma, this.autoReview);
    this.runs = new RunService(
      this.prisma,
      (path, init) => this.computerFetch(path, init),
      (callId, decision) => this.plugins.resolveInvocation(callId, decision),
      (details, decision) => this.plugins.resolveAction(details, decision),
      (connectionId, botId, toolName) =>
        Effect.runPromise(
          this.plugins.setPolicy(connectionId, { botId, toolName, decision: "allow" })
        ),
      this.messaging
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
    this.automationWebhooks = new AutomationWebhooksService(this.prisma, (owner, event) =>
      this.routines.dispatchEvent(owner, event)
    );
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
      this.plugins,
      this.richMessages
    );
    this.boss.on("error", (error) => console.error("pg-boss", error));

    this.settings = new SettingsService(this.agentData, (path, init) =>
      this.computerJson(path, init)
    );
  }

  boot = () =>
    serviceEffect(async () => {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.eventWakeup.start();
      await this.snapshots.pruneEvents();
      this.eventPruneTimer = setInterval(() => {
        void this.automationWebhooks
          .renew()
          .catch(() => console.warn("Automation subscription renewal failed"));
        void this.snapshots.pruneEvents().catch((error) => console.error("event retention", error));
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
      await this.richMessages.recoverPendingReviews();
      this.reviewRecoveryTimer = setInterval(() => {
        void this.richMessages
          .recoverPendingReviews()
          .catch((error) => console.error("review recovery", error));
      }, 30_000);
      this.reviewRecoveryTimer.unref?.();
      this.approvalExpiryTimer = setInterval(() => {
        void this.expirePendingApprovals().catch((error) =>
          console.error("approval expiry", error)
        );
      }, 60_000);
      this.approvalExpiryTimer.unref?.();
      // Asset pruning can scan a large history and filesystem. Keep the
      // lifecycle behavior without extending the server's critical startup path.
      queueMicrotask(() => {
        void this.pruneUnreferencedAssets().catch((error) => console.error("asset cleanup", error));
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
      await provisionDirectories(
        (path, init) => this.computerFetch(path, init),
        [
          resolve(this.workspaceRoot, "bots"),
          resolve(this.workspaceRoot, "projects"),
          resolve(this.workspaceRoot, "shared"),
          ...groups.flatMap((group) => (group.workingDirectory ? [group.workingDirectory] : [])),
        ]
      );
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
    });

  close = () =>
    Effect.promise(async () => {
      if (this.reviewRecoveryTimer) {
        clearInterval(this.reviewRecoveryTimer);
        this.reviewRecoveryTimer = null;
      }
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

  createBot = forwardServiceMethod(() => this.bots.create);
  duplicateBot = forwardServiceMethod(() => this.bots.duplicate);

  broadcast = (input: import("@openteam/contracts").AdminBroadcastInput) =>
    serviceEffect(() => this.messaging.broadcast(input));

  listBots = (includeHidden = false) => this.bots.list(includeHidden);
  listBotMemories = (botId: string) => serviceEffect(() => this.agentData.listBotMemories(botId));
  deleteBotMemories = (botId: string, memoryId?: string) =>
    serviceEffect(() => this.agentData.deleteBotMemories(botId, memoryId));

  updateBot = forwardServiceMethod(() => this.bots.update);

  retryBotProvisioning = forwardServiceMethod(() => this.bots.retryProvisioning);

  botTranscript = forwardServiceMethod(() => this.bots.transcript);

  listRoutines = (botId: string) => serviceEffect(() => this.routines.list(botId));

  listGroupRoutines = (channelId: string) =>
    serviceEffect(() => this.routines.listOwner({ kind: "group", id: channelId }));

  routineDetail = (routineId: string) =>
    serviceEffect(async () =>
      this.routines.detailOwner(await this.routines.owner(routineId), routineId)
    );

  createGroupRoutine = (channelId: string, clientId: string, input: RoutineMutationInput) =>
    serviceEffect(async () => {
      const owner = { kind: "group" as const, id: channelId };
      const created = await this.routines.mutateOwner(owner, clientId, null, {
        ...input,
        action: "create",
        source: "ui",
      });
      return this.routines.detailOwner(owner, String(created.id));
    });

  createRoutine = (botId: string, clientId: string, input: RoutineMutationInput) =>
    serviceEffect(async () => {
      const created = await this.routines.mutate(botId, clientId, null, {
        ...input,
        action: "create",
        source: "ui",
      });
      return this.routines.detail(botId, String(created.id));
    });

  updateRoutine = (routineId: string, clientId: string, input: RoutineMutationInput) =>
    serviceEffect(async () => {
      const owner = await this.routines.owner(routineId);
      await this.routines.mutateOwner(owner, clientId, null, {
        ...input,
        id: routineId,
        action: "update",
        source: "ui",
      });
      return this.routines.detailOwner(owner, routineId);
    });

  routineLifecycle = (
    routineId: string,
    clientId: string,
    action: "pause" | "resume" | "delete",
    expectedRevision?: number
  ) =>
    serviceEffect(async () => {
      const owner = await this.routines.owner(routineId);
      const result = await this.routines.mutateOwner(owner, clientId, null, {
        id: routineId,
        action,
        expectedRevision,
        source: "ui",
      });
      return action === "delete" ? result : this.routines.detailOwner(owner, routineId);
    });

  runRoutineNow = (routineId: string, clientId: string) =>
    serviceEffect(async () =>
      this.routines.runNowOwner(await this.routines.owner(routineId), routineId, clientId)
    );

  routineExecutions = (routineId: string, limit: number) =>
    serviceEffect(async () =>
      this.routines.executionsOwner(await this.routines.owner(routineId), routineId, limit)
    );

  screenStatus = forwardServiceMethod(() => this.screens.status);

  screenFrame = forwardServiceMethod(() => this.screens.frame);

  screenStream = forwardServiceMethod(() => this.screens.stream);

  botAvatar = forwardServiceMethod(() => this.screens.avatar);

  screenAction = forwardServiceMethod(() => this.screens.action);

  screenTakeover = forwardServiceMethod(() => this.screens.takeover);

  screenPause = forwardServiceMethod(() => this.screens.pause);

  archiveBot = forwardServiceMethod(() => this.bots.archive);

  sendMessage = forwardServiceMethod(() => this.channels.sendDirectMessage);

  messageDeliveryStatus = forwardServiceMethod(() => this.channels.messageDeliveryStatus);

  createGroup = forwardServiceMethod(() => this.channels.createGroup);

  listGroups = (includeHidden = false) => this.channels.listGroups(includeHidden);

  renameChannel = forwardServiceMethod(() => this.channels.renameDirectChannel);

  updateChannelProfile = forwardServiceMethod(() => this.channels.updateGroupProfile);

  setChannelAvatar = forwardServiceMethod(() => this.channels.setGroupAvatar);

  channelAvatar = forwardServiceMethod(() => this.channels.groupAvatar);

  setChannelMembers = forwardServiceMethod(() => this.channels.setGroupMembers);

  setChannelHidden = forwardServiceMethod(() => this.channels.setGroupHidden);

  deleteGroup = forwardServiceMethod(() => this.channels.deleteGroup);

  sendChannelMessage = forwardServiceMethod(() => this.channels.sendGroupMessage);

  reactToMessage = forwardServiceMethod(() => this.channels.reactToMessage);

  respondToWidget = forwardServiceMethod(() => this.richMessages.respondToWidget);
  mutateReviewAction = forwardServiceMethod(() => this.richMessages.reviewActions.mutate);
  reviewRecipe = (id: string, publicOnly = false) =>
    this.richMessages.reviewActions.recipe(id, publicOnly);
  mutateExternalDraft = forwardServiceMethod(() => this.richMessages.externalDrafts.mutate);
  submitUserForm = forwardServiceMethod(() => this.richMessages.submitUserForm);
  userFormPrefill = forwardServiceMethod(() => this.richMessages.formPrefill);

  dismissWidget = forwardServiceMethod(() => this.richMessages.dismissWidget);

  submitSecret = forwardServiceMethod(() => this.richMessages.submitSecret);

  mutateComputerHandoff = forwardServiceMethod(() => this.richMessages.mutateComputerHandoff);

  handleDynamicTool = forwardServiceMethod(() => this.internalTools.execute);

  pluginSettings = forwardServiceMethod(() => this.plugins.settings);

  pluginConnectionStatuses = forwardServiceMethod(() => this.plugins.pollConnectionStatuses);

  pluginBotAccess = forwardServiceMethod(() => this.plugins.botAccess);

  rootSettings = forwardServiceMethod(() => this.settings.rootSettings);

  serverSettings = forwardServiceMethod(() => this.settings.serverSettings);
  taskSettings = forwardServiceMethod(() => this.settings.taskSettings);
  updateTaskSettings = forwardServiceMethod(() => this.settings.updateTaskSettings);

  updateInferenceSettings = forwardServiceMethod(() => this.settings.updateInferenceSettings);

  startInferenceProviderAuth = forwardServiceMethod(() => this.settings.startInferenceProviderAuth);

  inferenceProviderAuthSession = forwardServiceMethod(
    () => this.settings.inferenceProviderAuthSession
  );

  respondToInferenceProviderAuth = forwardServiceMethod(
    () => this.settings.respondToInferenceProviderAuth
  );

  cancelInferenceProviderAuth = forwardServiceMethod(
    () => this.settings.cancelInferenceProviderAuth
  );

  disconnectInferenceProvider = forwardServiceMethod(
    () => this.settings.disconnectInferenceProvider
  );

  updateSidebarPreferences = forwardServiceMethod(() => this.settings.updateSidebarPreferences);

  activeAgent = forwardServiceMethod(() => this.settings.activeAgent);

  setActiveAgent = forwardServiceMethod(() => this.settings.setActiveAgent);

  installPlugin = forwardServiceMethod(() => this.plugins.install);

  addCustomMcp = forwardServiceMethod(() => this.plugins.addCustomMcp);

  uninstallPlugin = forwardServiceMethod(() => this.plugins.uninstall);

  connectPlugin = forwardServiceMethod(() => this.plugins.connect);

  disconnectPlugin = forwardServiceMethod(() => this.plugins.disconnect);

  addPluginAccount = forwardServiceMethod(() => this.plugins.addAccount);

  configurePluginConnection = forwardServiceMethod(() => this.plugins.configure);

  authenticatePlugin = forwardServiceMethod(() => this.plugins.authenticate);

  finishPluginAuthentication = forwardServiceMethod(() => this.plugins.finishAuthentication);

  restartPluginConnection = forwardServiceMethod(() => this.plugins.restart);

  renamePluginAccount = forwardServiceMethod(() => this.plugins.renameAccount);

  removePluginAccount = forwardServiceMethod(() => this.plugins.removeAccount);

  setMcpInstructions = forwardServiceMethod(() => this.plugins.setInstructions);

  setPluginGrant = forwardServiceMethod(() => this.plugins.setGrant);

  setPluginEnablement = forwardServiceMethod(() => this.plugins.setEnablement);

  setPluginPolicy = forwardServiceMethod(() => this.plugins.setPolicy);

  cancelRun = forwardServiceMethod(() => this.runs.cancel);

  resolveApproval = forwardServiceMethod(() => this.runs.resolveApproval);

  snapshot = forwardServiceMethod(() => this.snapshots.full);

  clientSnapshot = forwardServiceMethod(() => this.snapshots.client);

  clientBootstrap = forwardServiceMethod(() => this.snapshots.bootstrap);

  channelHistory = forwardServiceMethod(() => this.snapshots.history);

  channelMessageContext = forwardServiceMethod(() => this.snapshots.messageContext);

  channelClientState = forwardServiceMethod(() => this.snapshots.channelState);

  clientRuntime = forwardServiceMethod(() => this.snapshots.clientRuntime);

  uploadAsset = (input: UploadAssetInput) => serviceEffect(() => this.assets.decodeUpload(input));

  uploadBinaryAsset = (
    stream: ReadableStream<Uint8Array>,
    contentType: string,
    fileName: string | null,
    signal?: AbortSignal
  ) =>
    serviceEffect(() =>
      this.assets.ingestStream({
        stream,
        mimeType: contentType,
        fileName: fileName ?? "attachment",
        signal,
      })
    );

  registerPushDevice = forwardServiceMethod(() => this.notifications.register);

  unregisterPushDevice = forwardServiceMethod(() => this.notifications.unregister);

  disablePushDevicesForSession = forwardServiceMethod(() => this.notifications.disableForSession);

  markChannelRead = forwardServiceMethod(() => this.notifications.markChannelRead);

  reviewPermission = (input: AutoReviewInput) =>
    Effect.tryPromise({
      try: () => this.autoReview.review(input),
      catch: (error) => error as Error,
    });

  search = forwardServiceMethod(() => this.searchIndex.search);

  health = forwardServiceMethod(() => this.snapshots.health);

  eventsAfter = (sequence: bigint) => this.snapshots.eventsAfter(sequence);

  eventWindowAfter = (sequence: bigint, limit?: number) =>
    this.snapshots.eventWindowAfter(sequence, limit);

  waitForEvent = (version: number, timeoutMs: number, signal?: AbortSignal) =>
    this.eventWakeup.wait(version, timeoutMs, signal);

  get eventVersion() {
    return this.eventWakeup.currentVersion;
  }

  private async recover(): Promise<void> {
    return recover(this.prisma, this.boss, this.messaging, (path, init) =>
      this.computerFetch(path, init)
    );
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
}
