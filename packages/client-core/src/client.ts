import type {
  AddCustomMcpInput,
  ApprovalDecision,
  AssetRef,
  BotTranscriptView,
  BotView,
  ChannelClientState,
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
  ChannelView,
  ClientBootstrapView,
  ClientRuntimeView,
  ClientSnapshot,
  ConfigurePluginConnectionInput,
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  PluginBotAccessView,
  PluginConnectionStatusesView,
  PluginSettingsView,
  MessageDeliveryStatusView,
  ReactToChannelMessageInput,
  ReactToChannelMessageView,
  RegisterPushDeviceInput,
  RichMessageMutationView,
  RootSettingsView,
  RoutineExecutionView,
  RoutineView,
  ScreenActionInput,
  ScreenStatusView,
  SearchCategory,
  SearchResponse,
  SendMessageInput,
  SetChannelMembersInput,
  SetChannelHiddenInput,
  SetPluginToolPolicyInput,
  SidebarPreferences,
  SystemVersionView,
  UpdateBotInput,
  UpdateChannelProfileInput,
  UpdateRoutineInput,
  UploadAssetInput,
} from "@openbot/contracts";
import { PLUGIN_CONNECTION_STATUS_MAX_IDS } from "@openbot/contracts/plugin-settings";
import { consumeProductEventStream, type ProductEventHandlers } from "./events";
import { createJsonTransport, type OpenBotTransportOptions } from "./http";
import { normalizeClientSnapshot } from "./snapshot";

export interface OpenBotClientOptions extends OpenBotTransportOptions {
  createId?: () => string;
  timeZone?: () => string;
}

export interface SendMessageOptions {
  richText?: string;
  isFork?: boolean;
  /** Stable idempotency nonce supplied by the durable client send journal. */
  clientId?: string;
}

const fallbackId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const fallbackTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const createOpenBotClient = (options: OpenBotClientOptions) => {
  const transport = createJsonTransport(options);
  const createId = options.createId ?? fallbackId;
  const timeZone = options.timeZone ?? fallbackTimeZone;

  function uploadAsset(input: UploadAssetInput): Promise<AssetRef>;
  function uploadAsset(input: Blob, fileName?: string, mimeType?: string): Promise<AssetRef>;
  function uploadAsset(
    input: UploadAssetInput | Blob,
    fileName?: string,
    mimeType?: string
  ): Promise<AssetRef> {
    const blobLike =
      typeof input === "object" &&
      input !== null &&
      !("bytesBase64" in input) &&
      typeof input.arrayBuffer === "function";
    if (blobLike) {
      const headers = new Headers({
        "content-type": mimeType || input.type || "application/octet-stream",
      });
      if (fileName) headers.set("x-file-name", encodeURIComponent(fileName));
      return transport.request<AssetRef>("/api/v0/assets", {
        method: "POST",
        headers,
        body: input,
      });
    }
    return transport.request<AssetRef>("/api/v0/assets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  function assetUrl(asset: string | Pick<AssetRef, "assetId" | "fileName">, download = false) {
    const assetId = typeof asset === "string" ? asset : asset.assetId;
    const params = new URLSearchParams();
    if (typeof asset !== "string") params.set("name", asset.fileName);
    if (download) params.set("download", "1");
    const query = params.size > 0 ? `?${params}` : "";
    return `${transport.baseUrl}/api/v0/assets/${encodeURIComponent(assetId)}${query}`;
  }

  return {
    baseUrl: transport.baseUrl,
    systemVersion: () => transport.request<SystemVersionView>("/api/v0/system/version"),
    snapshot: () =>
      transport
        .request<ClientSnapshot>("/api/v0/client-snapshot")
        .then((snapshot) => normalizeClientSnapshot(snapshot)),
    rootSettings: () => transport.request<RootSettingsView>("/api/v0/settings"),
    bots: (includeHidden = false) =>
      transport.request<BotView[]>(`/api/v0/bots${includeHidden ? "?includeHidden=1" : ""}`),
    groups: (includeHidden = false) =>
      transport.request<ChannelView[]>(`/api/v0/groups${includeHidden ? "?includeHidden=1" : ""}`),
    updateSidebarPreferences: (input: SidebarPreferences) =>
      transport.request<SidebarPreferences>("/api/v0/settings/sidebar", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    activeAgent: () => transport.request<{ activeAgentId: string | null }>("/api/v0/active-agent"),
    setActiveAgent: (activeAgentId: string) =>
      transport.request("/api/v0/active-agent", {
        method: "PATCH",
        body: JSON.stringify({ activeAgentId }),
      }),
    pluginSettings: () => transport.request<PluginSettingsView>("/api/v0/plugins"),
    pluginConnectionStatuses: (connectionIds: readonly string[]) => {
      const params = new URLSearchParams();
      for (const connectionId of connectionIds.slice(0, PLUGIN_CONNECTION_STATUS_MAX_IDS)) {
        params.append("id", connectionId);
      }
      return transport.request<PluginConnectionStatusesView>(
        `/api/v0/plugin-connections/status?${params}`
      );
    },
    pluginBotAccess: (
      pluginKey: string,
      query: { query?: string; offset?: number; limit?: number; signal?: AbortSignal } = {}
    ) => {
      const params = new URLSearchParams();
      if (query.query) params.set("q", query.query);
      if (query.offset !== undefined) params.set("offset", String(query.offset));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params}` : "";
      return transport.request<PluginBotAccessView>(
        `/api/v0/plugins/${encodeURIComponent(pluginKey)}/bot-access${suffix}`,
        { signal: query.signal }
      );
    },
    installPlugin: (pluginKey: string, values?: Record<string, string>) =>
      transport.request("/api/v0/plugins/install", {
        method: "POST",
        body: JSON.stringify({ pluginKey, values }),
      }),
    addCustomMcp: (input: AddCustomMcpInput) =>
      transport.request("/api/v0/plugins/custom-mcp", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    uninstallPlugin: (pluginKey: string) =>
      transport.request(`/api/v0/plugins/${encodeURIComponent(pluginKey)}`, {
        method: "DELETE",
      }),
    setPluginEnablement: (
      pluginKey: string,
      botId: string,
      enabled: boolean,
      skillsEnabled = enabled
    ) =>
      transport.request(`/api/v0/plugins/${encodeURIComponent(pluginKey)}/enablement`, {
        method: "POST",
        body: JSON.stringify({ botId, enabled, skillsEnabled }),
      }),
    connectPlugin: (connectionId: string) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/connect`, {
        method: "POST",
      }),
    disconnectPlugin: (connectionId: string) =>
      transport.request(
        `/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/disconnect`,
        { method: "POST" }
      ),
    addPluginAccount: (connectionId: string, alias: string) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/accounts`, {
        method: "POST",
        body: JSON.stringify({ alias }),
      }),
    configurePluginConnection: (connectionId: string, input: ConfigurePluginConnectionInput) =>
      transport.request(
        `/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/configure`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    authenticatePlugin: (connectionId: string, force = false) =>
      transport.request<{ authorizationUrl: string; status: string }>(
        `/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/authenticate`,
        { method: "POST", body: JSON.stringify({ force }) }
      ),
    restartPluginConnection: (connectionId: string) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/restart`, {
        method: "POST",
      }),
    renamePluginAccount: (connectionId: string, alias: string) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/account`, {
        method: "PATCH",
        body: JSON.stringify({ alias }),
      }),
    removePluginAccount: (connectionId: string) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/account`, {
        method: "DELETE",
      }),
    setMcpInstructions: (connectionId: string, instructions: string) =>
      transport.request(
        `/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/instructions`,
        { method: "PATCH", body: JSON.stringify({ instructions }) }
      ),
    setPluginGrant: (connectionId: string, botId: string, enabled: boolean) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/grant`, {
        method: "POST",
        body: JSON.stringify({ botId, enabled }),
      }),
    setPluginPolicy: (connectionId: string, input: SetPluginToolPolicyInput) =>
      transport.request(`/api/v0/plugin-connections/${encodeURIComponent(connectionId)}/policy`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    bootstrap: () => transport.request<ClientBootstrapView>("/api/v0/client-bootstrap"),
    listenForEvents: async (
      after: string,
      handlers: ProductEventHandlers,
      signal?: AbortSignal
    ) => {
      const cursor = /^\d+$/.test(after) ? after : "0";
      const response = await transport.open(`/api/v0/events?after=${encodeURIComponent(cursor)}`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
      return consumeProductEventStream(response, handlers, signal);
    },
    runtime: () => transport.request<ClientRuntimeView>("/api/v0/client-runtime"),
    channelHistory: (
      channelId: string,
      options: { beforeSequence?: string; limit?: number } = {}
    ) => {
      const params = new URLSearchParams();
      if (options.beforeSequence) params.set("before", options.beforeSequence);
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      const query = params.size > 0 ? `?${params}` : "";
      return transport.request<ChannelHistoryPage>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/history${query}`
      );
    },
    channelState: (channelId: string) =>
      transport.request<ChannelClientState>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/client-state`
      ),
    messageContext: (messageId: string, options: { before?: number; after?: number } = {}) => {
      const params = new URLSearchParams();
      if (options.before !== undefined) params.set("before", String(options.before));
      if (options.after !== undefined) params.set("after", String(options.after));
      const query = params.size > 0 ? `?${params}` : "";
      return transport.request<ChannelMessageContextView>(
        `/api/v0/channel-messages/${encodeURIComponent(messageId)}/context${query}`
      );
    },
    messageDeliveryStatus: (channelId: string, clientId: string) =>
      transport.request<MessageDeliveryStatusView>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/message-deliveries/${encodeURIComponent(clientId)}`
      ),
    uploadAsset,
    assetUrl,
    search: (query: string, category: SearchCategory = "all", signal?: AbortSignal) => {
      const params = new URLSearchParams({ q: query, category });
      return transport.request<SearchResponse>(`/api/v0/search?${params}`, { signal });
    },
    botTranscript: (botId: string) =>
      transport.request<BotTranscriptView>(`/api/v0/bots/${encodeURIComponent(botId)}/transcript`),
    createBot: (input: CreateBotInput) =>
      transport.request<BotView>("/api/v0/bots", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateBot: (botId: string, input: UpdateBotInput) =>
      transport.request<BotView>(`/api/v0/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    archiveBot: (botId: string) =>
      transport.request(`/api/v0/bots/${encodeURIComponent(botId)}`, { method: "DELETE" }),
    retryBot: (botId: string) =>
      transport.request<BotView>(`/api/v0/bots/${encodeURIComponent(botId)}/retry`, {
        method: "POST",
      }),
    createGroup: (input: CreateGroupInput) =>
      transport.request<ChannelView>("/api/v0/channels", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    renameChannel: (channelId: string, name: string) =>
      transport.request<ChannelView>(`/api/v0/channels/${encodeURIComponent(channelId)}/name`, {
        method: "PATCH",
        body: JSON.stringify({ name, clientId: createId(), timeZone: timeZone() }),
      }),
    updateChannelProfile: (channelId: string, name: string, description: string) => {
      const input: UpdateChannelProfileInput = {
        name,
        description,
        clientId: createId(),
      };
      return transport.request<ChannelView>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/profile`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        }
      );
    },
    setChannelAvatar: (channelId: string, pngBase64: string | null) =>
      transport.request<ChannelView>(`/api/v0/channels/${encodeURIComponent(channelId)}/avatar`, {
        method: "PUT",
        body: JSON.stringify({ pngBase64, clientId: createId() }),
      }),
    setChannelMembers: (channelId: string, botIds: string[]) => {
      const input: SetChannelMembersInput = { botIds, clientId: createId() };
      return transport.request<ChannelView>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/members`,
        {
          method: "PUT",
          body: JSON.stringify(input),
        }
      );
    },
    setChannelHidden: (channelId: string, hidden: boolean) => {
      const input: SetChannelHiddenInput = { hidden, clientId: createId() };
      return transport.request<ChannelView>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/hidden`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        }
      );
    },
    deleteGroup: (channelId: string) =>
      transport.request<{ deleted: true; channelId: string }>(
        `/api/v0/channels/${encodeURIComponent(channelId)}`,
        { method: "DELETE" }
      ),
    sendDirectMessage: (
      conversationId: string,
      content: string,
      attachments: readonly AssetRef[] = [],
      replyToMessageId?: string,
      messageOptions?: SendMessageOptions
    ) => {
      const input: SendMessageInput = {
        content,
        attachments: [...attachments],
        replyToMessageId,
        ...(messageOptions?.richText ? { richText: messageOptions.richText } : {}),
        ...(messageOptions?.isFork !== undefined ? { isFork: messageOptions.isFork } : {}),
        clientId: messageOptions?.clientId ?? createId(),
        timeZone: timeZone(),
      };
      return transport.request<{ message: ChannelMessageView }>(
        `/api/v0/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
    },
    sendChannelMessage: (
      channelId: string,
      content: string,
      attachments: readonly AssetRef[] = [],
      replyToMessageId?: string,
      messageOptions?: SendMessageOptions
    ) => {
      const input: SendMessageInput = {
        content,
        attachments: [...attachments],
        replyToMessageId,
        ...(messageOptions?.richText ? { richText: messageOptions.richText } : {}),
        ...(messageOptions?.isFork !== undefined ? { isFork: messageOptions.isFork } : {}),
        clientId: messageOptions?.clientId ?? createId(),
        timeZone: timeZone(),
      };
      return transport.request<{ message: ChannelMessageView }>(
        `/api/v0/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
    },
    reactToMessage: (messageId: string, emoji: string) => {
      const input: ReactToChannelMessageInput = {
        emoji,
        clientId: createId(),
        timeZone: timeZone(),
      };
      return transport.request<ReactToChannelMessageView>(
        `/api/v0/channel-messages/${encodeURIComponent(messageId)}/reaction`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
    },
    respondToWidget: (messageId: string, value: string) =>
      transport.request<RichMessageMutationView>(
        `/api/v0/channel-messages/${encodeURIComponent(messageId)}/widget-response`,
        {
          method: "POST",
          body: JSON.stringify({ value, clientId: createId() }),
        }
      ),
    dismissWidget: (messageId: string) =>
      transport.request<RichMessageMutationView>(
        `/api/v0/channel-messages/${encodeURIComponent(messageId)}/widget-dismiss`,
        {
          method: "POST",
          body: JSON.stringify({ clientId: createId() }),
        }
      ),
    submitSecret: (messageId: string, value: string) =>
      transport.request<RichMessageMutationView>(
        `/api/v0/channel-messages/${encodeURIComponent(messageId)}/secret`,
        {
          method: "POST",
          body: JSON.stringify({ value, clientId: createId() }),
        }
      ),
    cancelRun: (runId: string) =>
      transport.request(`/api/v0/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
    resolveApproval: (approvalId: string, decision: ApprovalDecision) =>
      transport.request(`/api/v0/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    registerPushDevice: (input: RegisterPushDeviceInput) =>
      transport.request("/api/v0/notification-devices", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    unregisterPushDevice: (installationId: string) =>
      transport.request(`/api/v0/notification-devices/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
      }),
    markChannelRead: (channelId: string, throughSequence?: string) =>
      transport.request<{
        channelId: string;
        lastReadSequence: string;
        unreadCount: number;
      }>(`/api/v0/channels/${encodeURIComponent(channelId)}/read`, {
        method: "POST",
        body: JSON.stringify({ throughSequence }),
      }),
    screenStatus: (botId: string) =>
      transport.request<ScreenStatusView>(`/api/v0/bots/${encodeURIComponent(botId)}/screen`),
    screenAction: (botId: string, input: ScreenActionInput) =>
      transport.request<ScreenStatusView>(
        `/api/v0/bots/${encodeURIComponent(botId)}/screen/actions`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      ),
    setScreenTakeover: (botId: string, active: boolean) =>
      transport.request<ScreenStatusView>(
        `/api/v0/bots/${encodeURIComponent(botId)}/screen/takeover`,
        {
          method: "POST",
          body: JSON.stringify({ active }),
        }
      ),
    routines: (ownerId: string, ownerKind: "bot" | "group" = "bot") =>
      transport.request<RoutineView[]>(
        ownerKind === "bot"
          ? `/api/v0/bots/${encodeURIComponent(ownerId)}/routines`
          : `/api/v0/channels/${encodeURIComponent(ownerId)}/routines`
      ),
    routine: (routineId: string) =>
      transport.request<RoutineView>(`/api/v0/routines/${encodeURIComponent(routineId)}`),
    createRoutine: (ownerId: string, ownerKind: "bot" | "group", input: CreateRoutineInput) =>
      transport.request<RoutineView>(
        ownerKind === "bot"
          ? `/api/v0/bots/${encodeURIComponent(ownerId)}/routines`
          : `/api/v0/channels/${encodeURIComponent(ownerId)}/routines`,
        {
          method: "POST",
          body: JSON.stringify({ ...input, clientId: createId() }),
        }
      ),
    updateRoutine: (routineId: string, input: UpdateRoutineInput) =>
      transport.request<RoutineView>(`/api/v0/routines/${encodeURIComponent(routineId)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...input, clientId: createId() }),
      }),
    setRoutineEnabled: (routine: RoutineView, enabled: boolean) =>
      transport.request<RoutineView>(
        `/api/v0/routines/${encodeURIComponent(routine.id)}/${enabled ? "resume" : "pause"}`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: routine.revision, clientId: createId() }),
        }
      ),
    deleteRoutine: (routine: RoutineView) =>
      transport.request(`/api/v0/routines/${encodeURIComponent(routine.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision: routine.revision, clientId: createId() }),
      }),
    runRoutineNow: (routineId: string) =>
      transport.request<RoutineExecutionView>(
        `/api/v0/routines/${encodeURIComponent(routineId)}/test`,
        { method: "POST", body: JSON.stringify({ clientId: createId() }) }
      ),
    routineExecutions: (routineId: string, limit = 20) =>
      transport.request<RoutineExecutionView[]>(
        `/api/v0/routines/${encodeURIComponent(routineId)}/executions?limit=${encodeURIComponent(
          String(limit)
        )}`
      ),
    screenPause: (botId: string, paused: boolean) =>
      transport.request<ScreenStatusView>(
        `/api/v0/bots/${encodeURIComponent(botId)}/screen/pause`,
        { method: "POST", body: JSON.stringify({ paused }) }
      ),
    screenFrameUrl: (botId: string, revision = Date.now()) =>
      `${transport.baseUrl}/api/v0/bots/${encodeURIComponent(botId)}/screen/frame?v=${revision}`,
  };
};

export type OpenBotClient = ReturnType<typeof createOpenBotClient>;
