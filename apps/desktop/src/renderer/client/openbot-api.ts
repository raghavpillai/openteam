import type {
  ApprovalDecision,
  BotTranscriptView,
  BotView,
  ChannelView,
  ClientSnapshot,
  CreateBotInput,
  CreateGroupInput,
  InlineImageInput,
  PluginSettingsView,
  ScreenActionInput,
  ScreenStatusView,
  SearchCategory,
  SearchResponse,
  SetChannelMembersInput,
  SetPluginToolPolicyInput,
  UpdateBotInput,
} from "@openbot/contracts";
import type { RoutineExecutionView, RoutineView } from "../lib/routines";
import { API_BASE, request } from "./http";
import { authHeaders } from "./auth";

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const api = {
  snapshot: () => request<ClientSnapshot>("/api/v0/client-snapshot"),
  rootSettings: () =>
    request<{
      settings: { sidebarPreferences?: unknown };
      valid: boolean;
      error?: string;
    }>("/api/v0/settings"),
  updateSidebarPreferences: (input: unknown) =>
    request("/api/v0/settings/sidebar", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  activeAgent: () => request<{ activeAgentId: string | null }>("/api/v0/active-agent"),
  setActiveAgent: (activeAgentId: string) =>
    request("/api/v0/active-agent", {
      method: "PATCH",
      body: JSON.stringify({ activeAgentId }),
    }),
  pluginSettings: () => request<PluginSettingsView>("/api/v0/plugins"),
  installPlugin: (pluginKey: string) =>
    request("/api/v0/plugins/install", {
      method: "POST",
      body: JSON.stringify({ pluginKey }),
    }),
  addCustomMcp: (name: string, url: string, alias?: string) =>
    request("/api/v0/plugins/custom-mcp", {
      method: "POST",
      body: JSON.stringify({ name, url, alias }),
    }),
  uninstallPlugin: (pluginKey: string) =>
    request(`/api/v0/plugins/${encodeURIComponent(pluginKey)}`, {
      method: "DELETE",
    }),
  setPluginEnablement: (pluginKey: string, botId: string, enabled: boolean) =>
    request(`/api/v0/plugins/${encodeURIComponent(pluginKey)}/enablement`, {
      method: "POST",
      body: JSON.stringify({ botId, enabled, skillsEnabled: enabled }),
    }),
  connectPlugin: (connectionId: string) =>
    request(`/api/v0/plugin-connections/${connectionId}/connect`, {
      method: "POST",
    }),
  disconnectPlugin: (connectionId: string) =>
    request(`/api/v0/plugin-connections/${connectionId}/disconnect`, {
      method: "POST",
    }),
  addPluginAccount: (connectionId: string, alias: string) =>
    request(`/api/v0/plugin-connections/${connectionId}/accounts`, {
      method: "POST",
      body: JSON.stringify({ alias }),
    }),
  setPluginGrant: (connectionId: string, botId: string, enabled: boolean) =>
    request(`/api/v0/plugin-connections/${connectionId}/grant`, {
      method: "POST",
      body: JSON.stringify({ botId, enabled }),
    }),
  setPluginPolicy: (connectionId: string, input: SetPluginToolPolicyInput) =>
    request(`/api/v0/plugin-connections/${connectionId}/policy`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  search: (query: string, category: SearchCategory, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q: query, category });
    return request<SearchResponse>(`/api/v0/search?${params}`, { signal });
  },
  createBot: (input: CreateBotInput) =>
    request<BotView>("/api/v0/bots", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateBot: (botId: string, input: UpdateBotInput) =>
    request<BotView>(`/api/v0/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  archiveBot: (botId: string) => request(`/api/v0/bots/${botId}`, { method: "DELETE" }),
  retryBot: (botId: string) => request<BotView>(`/api/v0/bots/${botId}/retry`, { method: "POST" }),
  botTranscript: (botId: string) => request<BotTranscriptView>(`/api/v0/bots/${botId}/transcript`),
  routines: (botId: string) => request<RoutineView[]>(`/api/v0/bots/${botId}/routines`),
  routine: (routineId: string) => request<RoutineView>(`/api/v0/routines/${routineId}`),
  createRoutine: (
    botId: string,
    input: {
      name: string;
      prompt: string;
      schedule?: string;
      trigger?: unknown;
      presentation?: unknown;
      enabled: boolean;
    }
  ) =>
    request<RoutineView>(`/api/v0/bots/${botId}/routines`, {
      method: "POST",
      body: JSON.stringify({ ...input, clientId: crypto.randomUUID() }),
    }),
  updateRoutine: (
    routineId: string,
    input: {
      name?: string;
      prompt?: string;
      schedule?: string;
      trigger?: unknown;
      presentation?: unknown;
      enabled?: boolean;
      expectedRevision: number;
    }
  ) =>
    request<RoutineView>(`/api/v0/routines/${routineId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...input, clientId: crypto.randomUUID() }),
    }),
  setRoutineEnabled: (routine: RoutineView, enabled: boolean) =>
    request<RoutineView>(`/api/v0/routines/${routine.id}/${enabled ? "resume" : "pause"}`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: routine.revision,
        clientId: crypto.randomUUID(),
      }),
    }),
  deleteRoutine: (routine: RoutineView) =>
    request(`/api/v0/routines/${routine.id}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedRevision: routine.revision,
        clientId: crypto.randomUUID(),
      }),
    }),
  runRoutineNow: (routineId: string) =>
    request<RoutineExecutionView>(`/api/v0/routines/${routineId}/test`, {
      method: "POST",
      body: JSON.stringify({ clientId: crypto.randomUUID() }),
    }),
  routineExecutions: (routineId: string) =>
    request<RoutineExecutionView[]>(`/api/v0/routines/${routineId}/executions?limit=20`),
  createGroup: (input: CreateGroupInput) =>
    request<ChannelView>("/api/v0/channels", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  renameChannel: (channelId: string, name: string) =>
    request<ChannelView>(`/api/v0/channels/${channelId}/name`, {
      method: "PATCH",
      body: JSON.stringify({
        name,
        clientId: crypto.randomUUID(),
        timeZone: localTimeZone(),
      }),
    }),
  setChannelMembers: (channelId: string, botIds: string[]) =>
    request<ChannelView>(`/api/v0/channels/${channelId}/members`, {
      method: "PUT",
      body: JSON.stringify({
        botIds,
        clientId: crypto.randomUUID(),
      } satisfies SetChannelMembersInput),
    }),
  sendMessage: (
    conversationId: string,
    content: string,
    images: readonly InlineImageInput[],
    replyToMessageId?: string,
    options?: { richText?: string; isFork?: boolean }
  ) =>
    request(`/api/v0/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        images,
        replyToMessageId,
        ...options,
        clientId: crypto.randomUUID(),
        timeZone: localTimeZone(),
      }),
    }),
  sendChannelMessage: (
    channelId: string,
    content: string,
    images: readonly InlineImageInput[],
    replyToMessageId?: string,
    options?: { richText?: string; isFork?: boolean }
  ) =>
    request(`/api/v0/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        images,
        replyToMessageId,
        ...options,
        clientId: crypto.randomUUID(),
        timeZone: localTimeZone(),
      }),
    }),
  reactToMessage: (messageId: string, emoji: string) =>
    request(`/api/v0/channel-messages/${messageId}/reaction`, {
      method: "POST",
      body: JSON.stringify({
        emoji,
        clientId: crypto.randomUUID(),
        timeZone: localTimeZone(),
      }),
    }),
  cancelRun: (runId: string) => request(`/api/v0/runs/${runId}/cancel`, { method: "POST" }),
  resolveApproval: (approvalId: string, decision: ApprovalDecision) =>
    request(`/api/v0/approvals/${approvalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  screenStatus: (botId: string) => request<ScreenStatusView>(`/api/v0/bots/${botId}/screen`),
  screenAction: (botId: string, input: ScreenActionInput) =>
    request<ScreenStatusView>(`/api/v0/bots/${botId}/screen/actions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  screenTakeover: (botId: string, active: boolean) =>
    request<ScreenStatusView>(`/api/v0/bots/${botId}/screen/takeover`, {
      method: "POST",
      body: JSON.stringify({ active }),
    }),
  releaseScreenTakeover: (botId: string) => {
    void fetch(`${API_BASE}/api/v0/bots/${botId}/screen/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ active: false }),
      keepalive: true,
    }).catch(() => undefined);
  },
  screenPause: (botId: string, paused: boolean) =>
    request<ScreenStatusView>(`/api/v0/bots/${botId}/screen/pause`, {
      method: "POST",
      body: JSON.stringify({ paused }),
    }),
  screenFrameUrl: (botId: string, revision = Date.now()) =>
    `${API_BASE}/api/v0/bots/${botId}/screen/frame?v=${revision}`,
};
