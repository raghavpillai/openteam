import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type ApprovalDecision,
  type ComputerEvent,
  type ComputerSteerRequest,
  type ComputerTurnRequest,
  DEFAULT_PI_INFERENCE_MODEL,
  DEFAULT_PI_INFERENCE_PROVIDER,
  DEFAULT_PI_REASONING_LEVEL,
  formatPiModelRef,
  parsePiModelRef,
  type PiModelRef,
  piModelRef,
  type PiReasoningLevel,
  SEND_TO_USER_CLOSING_NUDGE_PROMPT,
  SEND_TO_USER_REPLY_NUDGE_PROMPT,
  type ServerInferenceSettings,
} from "@openteam/contracts";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BotAgentStore } from "./bot-agent-store";
import {
  BOT_IMAGE_TRIGGER,
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  type BotMessage,
  botPiPersistReserve,
  type BotSummaryRequest,
  type BotSummaryResult,
  botUserInfoMessage,
  countBotImages,
  replaceBotUserInfo,
} from "./bot-compaction";
import { ComputerEventQueue } from "./computer-event-queue";
import { InferenceProviderService } from "./inference-providers";
import { requireInferenceModel } from "./inference-models";
import { decodeInlineImages, loadAttachmentImages } from "./runtime/attachments";
import { compactionExtension, inferCompaction } from "./runtime/compaction";
import { textFromContent } from "./runtime/content";
import { attachSession, routeEvent } from "./runtime/events";
import { assertSessionPath } from "./runtime/session-path";
import { RuntimeTools } from "./runtime/tools";
import type { ActiveTurn, RuntimeImage, TurnStatus } from "./runtime/types";
import { ScreenBroker } from "./screen-broker";

export const REPLY_NUDGE_PROMPT = SEND_TO_USER_REPLY_NUDGE_PROMPT;

export const CLOSING_SEND_NUDGE_PROMPT = SEND_TO_USER_CLOSING_NUDGE_PROMPT;

export const isDeliveryOwed = (
  requestSource: NonNullable<ComputerTurnRequest["requestSource"]>
): boolean => ["turn", "handoff-resume", "broadcast", "connector"].includes(requestSource);

export class ComputerRuntime {
  private readonly tools: RuntimeTools;

  private readonly activeByRun = new Map<string, ActiveTurn>();
  private readonly activeByContext = new Map<string, ActiveTurn>();
  private readonly serverUrl = process.env.OPENTEAM_SERVER_URL ?? "http://127.0.0.1:8787";
  private readonly controlToken =
    process.env.OPENTEAM_CONTROL_TOKEN ?? "local-compose-only-change-me";
  private readonly agentDir = resolve(process.env.OPENTEAM_PI_AGENT_DIR ?? "/home/box/.pi/agent");
  private readonly sessionsDir = join(this.agentDir, "sessions", "openteam");
  private readonly contextSessionsDir = join(this.agentDir, "context-sessions");
  private readonly defaultModelRef = piModelRef(
    DEFAULT_PI_INFERENCE_PROVIDER,
    DEFAULT_PI_INFERENCE_MODEL
  );
  private readonly workspaceRoot = resolve(process.env.OPENTEAM_WORKSPACE_ROOT ?? "/workspace");

  private readonly defaultReasoning = DEFAULT_PI_REASONING_LEVEL;
  private modelRuntime: ModelRuntime | null = null;
  private readonly inferenceProviders = new InferenceProviderService(
    () => this.requireModelRuntime(),
    join(this.agentDir, "models.json")
  );
  private readonly compactionArchive = new BotCompactionArchiveStore(this.contextSessionsDir);
  private readonly compaction = new BotCompactionCoordinator(this.compactionArchive);
  private authenticated = false;
  private authentication: { type: "api_key" | "oauth"; source?: string } | undefined;
  private started = false;

  constructor(
    private readonly screens = new ScreenBroker(),
    private readonly botStore?: BotAgentStore,
    private readonly onTurnEnd?: (dirty: {
      botId: string;
      screenBotId: string;
      cwd: string;
      sessionPath: string | null;
    }) => void
  ) {
    this.tools = new RuntimeTools(
      screens,
      this.serverUrl,
      this.controlToken,
      this.agentDir,
      this.workspaceRoot
    );
  }

  async start(): Promise<void> {
    if (!this.started) {
      await mkdir(this.sessionsDir, { recursive: true });
      await mkdir(this.contextSessionsDir, { recursive: true });
      this.modelRuntime = await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
        modelsStorePath: join(this.agentDir, "models-store.json"),
        allowModelNetwork: false,
      });
      this.started = true;
    }
    await this.refreshAuthentication();
  }

  get diagnostics() {
    return {
      ready: this.started && this.modelRuntime !== null,
      runtimeEngine: "pi",
      inferenceProvider: this.defaultModelRef.providerId,
      model: this.defaultModelRef.modelId,
      qualifiedModel: formatPiModelRef(this.defaultModelRef),
      authenticated: this.authenticated,
      authType: this.authentication?.type ?? null,
      authSource: this.authentication?.source ?? null,
      subscription:
        this.authenticated &&
        Boolean(this.modelRuntime?.isUsingSubscription(this.defaultModelRef.providerId)),
      sessionScope: "transcript",
      activeTurns: this.activeByRun.size,
    };
  }

  async inferenceDiagnostics(model?: string) {
    await this.start();
    const modelRef = model
      ? parsePiModelRef(model, this.defaultModelRef.providerId)
      : this.defaultModelRef;
    const selectedModel = this.resolveModel(modelRef);
    const authentication = await this.requireModelRuntime().checkAuth(modelRef.providerId);
    return {
      ready: true,
      runtimeEngine: "pi",
      inferenceProvider: modelRef.providerId,
      model: modelRef.modelId,
      qualifiedModel: formatPiModelRef(modelRef),
      authenticated: Boolean(authentication),
      authType: authentication?.type ?? null,
      authSource: authentication?.source ?? null,
      subscription:
        Boolean(authentication) &&
        this.requireModelRuntime().isUsingSubscription(modelRef.providerId),
      reasoning: clampThinkingLevel(selectedModel, this.defaultReasoning),
      sessionScope: "transcript",
      activeTurns: this.activeByRun.size,
    };
  }

  async providerCatalog(providerId?: string) {
    await this.start();
    return this.inferenceProviders.catalog(providerId);
  }

  async verifyInferenceSettings(settings: ServerInferenceSettings): Promise<void> {
    await this.start();
    await this.inferenceProviders.verify(settings);
  }

  async disconnectInferenceProvider(providerId: string): Promise<void> {
    await this.start();
    await this.inferenceProviders.disconnect(providerId);
  }

  async startInferenceProviderAuth(providerId: string, authType: "api_key" | "oauth") {
    await this.start();
    return this.inferenceProviders.startAuthSession(providerId, authType);
  }

  async inferenceProviderAuthSession(sessionId: string) {
    await this.start();
    return this.inferenceProviders.authSession(sessionId);
  }

  async respondToInferenceProviderAuth(sessionId: string, promptId: string, value: string) {
    await this.start();
    return this.inferenceProviders.respond(sessionId, promptId, value);
  }

  async cancelInferenceProviderAuth(sessionId: string): Promise<void> {
    await this.start();
    this.inferenceProviders.cancel(sessionId);
  }

  async run(request: ComputerTurnRequest): Promise<AsyncIterable<ComputerEvent>> {
    await this.start();
    const modelRef = this.parseRuntimeModelRef(request.model);
    if (this.activeByRun.has(request.runId)) {
      throw new Error(`Run ${request.runId} is already active`);
    }
    if (this.activeByContext.has(request.contextSessionId)) {
      throw new Error(`Context ${request.contextSessionId} already has an active Pi turn`);
    }

    const queue = new ComputerEventQueue();
    const active: ActiveTurn = {
      runId: request.runId,
      botId: request.botId,
      contextSessionId: request.contextSessionId,
      screenBotId: request.screenBotId ?? request.botId,
      conversationId: request.conversationId,
      channelId: request.channelId,
      deliveryId: request.deliveryId,
      runtimeProfile: request.runtimeProfile ?? "agent",
      subagentType: request.subagentType ?? null,
      modelRef,
      reasoning: request.reasoning,
      cwd: request.cwd,
      instructions: request.instructions,
      userInfoMessage: request.userInfo
        ? botUserInfoMessage(request.userInfo, request.userInfoEpoch ?? 0)
        : null,
      todoUpdate: request.todoUpdate ?? null,
      automationTrigger: request.automationTrigger ?? null,
      resetSelfSummaryCount: request.resetSelfSummaryCount !== false,
      requestSource: request.requestSource ?? "turn",
      turnId: request.runId,
      session: null,
      sessionPath: null,
      sessionAttached: false,
      queue,
      unsubscribe: null,
      assistantOrdinal: 0,
      currentAssistantId: null,
      currentReasoningId: null,
      startedItems: new Set(),
      toolArgs: new Map(),
      lastStopReason: null,
      lastErrorMessage: null,
      sentMessageCount: 0,
      toolActivityAfterLastSend: false,
      initialUserStarted: false,
      pendingSteers: [],
      acceptedSteerIds: new Set(),
      discoveredDynamicTools: new Set(),
      pluginNamespaces: request.dynamicNamespaces ?? [],
      attachmentTempDirectories: [],
    };
    this.activeByRun.set(active.runId, active);
    this.activeByContext.set(active.contextSessionId, active);

    try {
      this.resolveModel(modelRef);
      const authentication = await this.modelRuntime?.checkAuth(modelRef.providerId);
      if (!authentication) {
        throw new Error(`Pi inference provider ${modelRef.providerId} is not configured`);
      }
      await this.botStore?.openForWake(active.botId);
      await this.botStore?.recordRequestId(active.botId, active.runId);
      await this.botStore?.appendConversationEnvelope(active.botId, {
        role: "system",
        content: active.instructions,
        contextSessionId: active.contextSessionId,
        turnId: active.turnId,
      });
      if (request.agentProfileSnapshot) {
        await this.botStore?.setPromptSnapshot(
          active.botId,
          "agentProfilePromptSnapshot",
          request.agentProfileSnapshot
        );
      }
      if (request.memorySnapshot) {
        await this.botStore?.setPromptSnapshot(
          active.botId,
          "memoryPromptSnapshot",
          request.memorySnapshot
        );
      }
      await this.botStore?.appendConversationEnvelope(active.botId, {
        role: "user",
        content: request.content,
        images: request.images?.length ?? 0,
        contextSessionId: active.contextSessionId,
        turnId: active.turnId,
      });
      // Reserve the run/context before the first asynchronous setup operation.
      // Otherwise two requests can both pass the checks above and open the same
      // append-only Pi session concurrently.
      const sessionPath = request.sessionPath
        ? assertSessionPath(this.sessionsDir, request.sessionPath)
        : null;
      const contextState = await this.contextState(active.contextSessionId);
      await this.compactionArchive.enforceSizeLimit(active.contextSessionId, sessionPath);
      const uploadedImages = decodeInlineImages(request.images ?? []);
      const attachments = await loadAttachmentImages(request.cwd, request.fileAttachments ?? []);
      active.attachmentTempDirectories = attachments.tempDirectories;
      const session = await this.createSession({ ...request, sessionPath }, active);
      const openedSessionPath = session.sessionFile;
      if (!openedSessionPath) {
        session.dispose();
        throw new Error("Pi did not create a durable session file");
      }
      assertSessionPath(this.sessionsDir, openedSessionPath);
      active.session = session;
      active.sessionPath = openedSessionPath;
      active.unsubscribe = session.subscribe((event) => this.routeEvent(active, event));
      await this.compactionArchive.enforceSizeLimit(active.contextSessionId, active.sessionPath);
      if (sessionPath) attachSession(active);
      queue.push(contextState);
      queue.push({ type: "turn.started", turnId: active.turnId });
      const images = [...uploadedImages, ...attachments.images].slice(0, 16);
      void this.execute(active, request.content, images);
      return queue;
    } catch (error) {
      this.cleanup(active);
      await Promise.allSettled(
        active.attachmentTempDirectories.map((directory) =>
          rm(directory, { recursive: true, force: true })
        )
      );
      throw error;
    }
  }

  async contextState(
    contextSessionId: string
  ): Promise<Extract<ComputerEvent, { type: "context.state" }>> {
    await mkdir(this.contextSessionsDir, { recursive: true });
    await this.recoverStagedCompaction(contextSessionId);
    const manifest = await this.compactionArchive.manifest(contextSessionId);
    return {
      type: "context.state",
      contextSessionId,
      epoch: manifest.epoch,
      archives: manifest.archives.map((archive) => ({
        id: archive.id,
        sequence: archive.sequence,
        reason: archive.reason,
        prefixDigest: archive.prefixDigest,
        summaryDigest: archive.summaryDigest,
        tokensBefore: archive.tokensBefore,
        tokensAfter: archive.tokensAfter,
        imageCount: archive.imageCount,
        turnCount: archive.turnCount,
        startedAt: archive.startedAt,
        completedAt: archive.completedAt,
      })),
    };
  }

  private async recoverStagedCompaction(contextSessionId: string): Promise<void> {
    const stagedId = await this.compaction.stagedId(contextSessionId);
    if (!stagedId) return;
    if (!existsSync(this.sessionsDir)) {
      await this.compaction.recoverStaged(contextSessionId, 0, []);
      return;
    }
    const suffix = `_${contextSessionId}.jsonl`;
    const candidates = (await readdir(this.sessionsDir)).filter((name) => name.endsWith(suffix));
    if (candidates.length > 1) {
      throw new Error(`Multiple Pi sessions exist for context ${contextSessionId}`);
    }
    const candidate = candidates[0];
    if (!candidate) {
      await this.compaction.recoverStaged(contextSessionId, 0, []);
      return;
    }
    const sessionPath = assertSessionPath(this.sessionsDir, join(this.sessionsDir, candidate));
    const manager = SessionManager.open(sessionPath, this.sessionsDir);
    const persistedCompactionIds = manager.getBranch().flatMap((entry) => {
      if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") {
        return [];
      }
      const details = entry.details as Record<string, unknown>;
      return details.openteamBotCompaction === true && typeof details.id === "string"
        ? [details.id]
        : [];
    });
    await this.compaction.recoverStaged(
      contextSessionId,
      manager.buildSessionContext().messages.length,
      persistedCompactionIds
    );
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeByRun.get(runId);
    if (!active?.session) throw new Error("Run is not actively executing");
    await active.session.abort();
  }

  async deleteContextSession(contextSessionId: string, sessionPath?: string): Promise<void> {
    if (this.activeByContext.has(contextSessionId)) {
      throw new Error("Cannot delete an active context session");
    }
    await this.compaction.remove(contextSessionId);
    if (sessionPath) {
      await rm(assertSessionPath(this.sessionsDir, sessionPath), { force: true });
    }
  }

  async steer(runId: string, request: ComputerSteerRequest): Promise<void> {
    const active = this.activeByRun.get(runId);
    if (!active?.session || !active.session.isStreaming) {
      throw new Error("Run is not actively processing a Pi turn");
    }
    if (active.acceptedSteerIds.has(request.inboxId)) return;
    const pending = {
      inboxId: request.inboxId,
      clientMessageId: request.clientMessageId,
      content: request.content,
    };
    active.acceptedSteerIds.add(request.inboxId);
    active.pendingSteers.push(pending);
    try {
      const images = decodeInlineImages(request.images ?? []);
      await active.session.prompt(request.content, {
        source: "rpc",
        streamingBehavior: "steer",
        ...(images.length ? { images } : {}),
      });
    } catch (error) {
      active.acceptedSteerIds.delete(request.inboxId);
      const index = active.pendingSteers.findIndex(
        (candidate) => candidate.inboxId === request.inboxId
      );
      if (index >= 0) active.pendingSteers.splice(index, 1);
      throw error;
    }
  }

  async infer(request: {
    instructions: string;
    prompt: string;
    cwd: string;
    timeoutMs: number;
    model: string;
    reasoning: PiReasoningLevel;
  }): Promise<string> {
    await this.start();
    const modelRef = this.parseRuntimeModelRef(request.model);
    const modelRuntime = this.requireModelRuntime();
    if (!(await modelRuntime.checkAuth(modelRef.providerId))) {
      throw new Error(`Pi inference provider ${modelRef.providerId} is not configured`);
    }
    const model = this.resolveModel(modelRef);
    const thinkingLevel = clampThinkingLevel(model, request.reasoning);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref();
    try {
      const result = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: request.instructions,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: request.prompt }],
              timestamp: Date.now(),
            },
          ] as never,
          tools: [],
        },
        {
          signal: controller.signal,
          reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
        }
      );
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(result.errorMessage || `Memory inference ${result.stopReason}`);
      }
      const assistantText = textFromContent(result.content);
      if (!assistantText.trim()) throw new Error("Memory inference returned no assistant text");
      return assistantText;
    } catch (error) {
      if (timedOut) throw new Error("Memory inference timed out", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    return this.tools.resolveApproval(approvalId, decision);
  }

  private async refreshAuthentication(): Promise<void> {
    this.authentication = await this.modelRuntime?.checkAuth(this.defaultModelRef.providerId);
    this.authenticated = Boolean(this.authentication);
  }

  private resolveModel(ref: PiModelRef) {
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
    return requireInferenceModel(modelRuntime, ref);
  }

  private requireModelRuntime(): ModelRuntime {
    if (!this.modelRuntime) throw new Error("Pi model runtime is not initialized");
    return this.modelRuntime;
  }

  private parseRuntimeModelRef(value: string): PiModelRef {
    if (!value.includes("/")) throw new Error("A provider-qualified inference model is required");
    return parsePiModelRef(value, this.defaultModelRef.providerId);
  }

  private async createSession(
    request: ComputerTurnRequest,
    active: ActiveTurn
  ): Promise<AgentSession> {
    const manager = request.sessionPath
      ? SessionManager.open(
          assertSessionPath(this.sessionsDir, request.sessionPath),
          this.sessionsDir,
          request.cwd
        )
      : SessionManager.create(request.cwd, this.sessionsDir, {
          id: request.contextSessionId,
        });
    return this.createStandaloneSession(
      request.cwd,
      request.instructions,
      manager,
      active,
      active.modelRef
    );
  }

  private async createStandaloneSession(
    cwd: string,
    instructions: string,
    sessionManager: SessionManager,
    active: ActiveTurn,
    modelRef: PiModelRef
  ): Promise<AgentSession> {
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
    const model = this.resolveModel(modelRef);
    const thinkingLevel = clampThinkingLevel(model, active.reasoning);
    const persistReserve = botPiPersistReserve(model.contextWindow ?? 0);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: modelRef.providerId,
      defaultModel: modelRef.modelId,
      defaultThinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
      compaction: {
        enabled: true,
        reserveTokens: persistReserve,
        keepRecentTokens: 1,
      },
      retry: { enabled: true, maxRetries: 3 },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: instructions,
      extensionFactories: [this.compactionExtension(sessionManager, active)],
    });
    await resourceLoader.reload();
    const customTools = this.customTools(active);
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      thinkingLevel,
      noTools: "builtin",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    return session;
  }

  private compactionExtension(
    sessionManager: SessionManager,
    active: ActiveTurn
  ): { name: string; hidden: boolean; factory: ExtensionFactory } {
    return compactionExtension(
      this.compaction,
      (...args) => this.inferCompaction(...args),
      sessionManager,
      active
    );
  }

  private async inferCompaction(
    active: ActiveTurn,
    request: BotSummaryRequest,
    signal: AbortSignal
  ): Promise<BotSummaryResult> {
    return inferCompaction(
      this.modelRuntime,
      (ref) => this.resolveModel(ref),
      (turn) => this.customTools(turn),
      active,
      request,
      signal
    );
  }

  private customTools(active: ActiveTurn) {
    return this.tools.customTools(active);
  }

  private async execute(
    active: ActiveTurn,
    content: string,
    images: RuntimeImage[]
  ): Promise<void> {
    let status: TurnStatus = "completed";
    let error: unknown;
    try {
      const session = active.session;
      if (!session) throw new Error("Pi session is not attached");
      await this.compaction.beginUserQuery(active.contextSessionId, active.resetSelfSummaryCount);
      await active.session?.prompt(content, { source: "rpc", images });
      if (isDeliveryOwed(active.requestSource)) {
        if (active.sentMessageCount === 0) {
          await session.prompt(REPLY_NUDGE_PROMPT, {
            source: "rpc",
            expandPromptTemplates: false,
          });
        } else if (active.toolActivityAfterLastSend) {
          await session.prompt(CLOSING_SEND_NUDGE_PROMPT, {
            source: "rpc",
            expandPromptTemplates: false,
          });
        }
      }
      const completedContext = replaceBotUserInfo(
        await this.compaction.contextMessages(
          active.contextSessionId,
          session.messages as BotMessage[]
        ),
        active.userInfoMessage
      );
      const imagePersist = countBotImages(completedContext) >= BOT_IMAGE_TRIGGER;
      const projectedReason = this.compaction.projectedReason(active.contextSessionId);
      const projectedCommit = this.compaction.consumeProjectedCommit(active.contextSessionId);
      if (!projectedCommit && (imagePersist || projectedReason) && completedContext.length >= 3) {
        const forcedReason = imagePersist ? "approaching_image_limit" : projectedReason;
        if (!forcedReason) throw new Error("Missing forced compaction reason");
        this.compaction.forceReason(active.contextSessionId, forcedReason);
        try {
          await session.compact();
        } finally {
          this.compaction.clearForcedReason(active.contextSessionId);
        }
      }
      if (active.lastStopReason === "aborted") status = "interrupted";
      else if (active.lastStopReason === "error") {
        status = "failed";
        error = { message: active.lastErrorMessage ?? "Pi turn failed" };
      }
    } catch (caught) {
      status = "failed";
      error = {
        message: caught instanceof Error ? caught.message : String(caught),
      };
      active.queue.push({
        type: "runtime.error",
        turnId: active.turnId,
        message: (error as { message: string }).message,
        retrying: false,
      });
    } finally {
      this.compaction.discardBackground(active.contextSessionId);
      attachSession(active);
      if (this.botStore) {
        await this.botStore
          .recordTurnSettlement(active.botId, {
            turnId: active.turnId,
            status,
            ...(error === undefined ? {} : { error }),
          })
          .catch((settlementError) => console.warn("turn settlement persistence", settlementError));
      }
      active.queue.push({
        type: "turn.completed",
        turnId: active.turnId,
        status,
        error,
      });
      this.cleanup(active);
      await Promise.allSettled(
        active.attachmentTempDirectories.map((directory) =>
          rm(directory, { recursive: true, force: true })
        )
      );
      this.onTurnEnd?.({
        botId: active.botId,
        screenBotId: active.screenBotId,
        cwd: active.cwd,
        sessionPath: active.sessionPath,
      });
      active.queue.end();
    }
  }

  private routeEvent(active: ActiveTurn, event: AgentSessionEvent): void {
    return routeEvent(
      this.botStore,
      this.compaction,
      (...args) => this.inferCompaction(...args),
      active,
      event
    );
  }

  private cleanup(active: ActiveTurn): void {
    this.tools.cancelApprovals(active.runId);
    this.activeByRun.delete(active.runId);
    this.activeByContext.delete(active.contextSessionId);
    active.unsubscribe?.();
    active.unsubscribe = null;
    active.session?.dispose();
    active.session = null;
  }
}

export { decodeInlineImages } from "./runtime/attachments";

export { modelVisibleSummaryTools } from "./runtime/compaction";
