import type {
  ApprovalDecision,
  BotTranscriptView,
  BotView,
  ChannelView,
  ClientSnapshot,
  CreateBotInput,
  CreateGroupInput,
  ScreenActionInput,
  ScreenStatusView,
  UpdateBotInput,
} from "@openbot/contracts";
import { API_BASE, request } from "./http";

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const api = {
  snapshot: () => request<ClientSnapshot>("/api/v0/client-snapshot"),
  createBot: (input: CreateBotInput) =>
    request<BotView>("/api/v0/bots", { method: "POST", body: JSON.stringify(input) }),
  updateBot: (botId: string, input: UpdateBotInput) =>
    request<BotView>(`/api/v0/bots/${botId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveBot: (botId: string) => request(`/api/v0/bots/${botId}`, { method: "DELETE" }),
  retryBot: (botId: string) => request<BotView>(`/api/v0/bots/${botId}/retry`, { method: "POST" }),
  botTranscript: (botId: string) => request<BotTranscriptView>(`/api/v0/bots/${botId}/transcript`),
  createGroup: (input: CreateGroupInput) =>
    request<ChannelView>("/api/v0/channels", { method: "POST", body: JSON.stringify(input) }),
  sendMessage: (conversationId: string, content: string) =>
    request(`/api/v0/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, clientId: crypto.randomUUID(), timeZone: localTimeZone() }),
    }),
  sendChannelMessage: (channelId: string, content: string) =>
    request(`/api/v0/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, clientId: crypto.randomUUID(), timeZone: localTimeZone() }),
    }),
  compact: (conversationId: string) =>
    request(`/api/v0/conversations/${conversationId}/compact`, { method: "POST" }),
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
      headers: { "content-type": "application/json" },
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
