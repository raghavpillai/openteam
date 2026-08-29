import type {
  ApprovalDecision,
  BotTranscriptView,
  ClientSnapshot,
  InlineImageInput,
  ReactToChannelMessageInput,
  ScreenActionInput,
  ScreenStatusView,
  SearchCategory,
  SearchResponse,
  SendMessageInput,
} from "@openbot/contracts";
import { createJsonTransport, type OpenBotTransportOptions } from "./http";
import { normalizeClientSnapshot } from "./snapshot";

export interface RoutineExecutionView {
  id: string;
  routineId: string;
  status: string;
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RoutineView {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  revision: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  latestExecution: RoutineExecutionView | null;
}

export interface OpenBotClientOptions extends OpenBotTransportOptions {
  createId?: () => string;
  timeZone?: () => string;
}

const fallbackId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const fallbackTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const createOpenBotClient = (options: OpenBotClientOptions) => {
  const transport = createJsonTransport(options);
  const createId = options.createId ?? fallbackId;
  const timeZone = options.timeZone ?? fallbackTimeZone;

  return {
    baseUrl: transport.baseUrl,
    snapshot: () =>
      transport
        .request<ClientSnapshot>("/api/v0/client-snapshot")
        .then((snapshot) => normalizeClientSnapshot(snapshot)),
    search: (query: string, category: SearchCategory = "all", signal?: AbortSignal) => {
      const params = new URLSearchParams({ q: query, category });
      return transport.request<SearchResponse>(`/api/v0/search?${params}`, { signal });
    },
    botTranscript: (botId: string) =>
      transport.request<BotTranscriptView>(`/api/v0/bots/${encodeURIComponent(botId)}/transcript`),
    sendDirectMessage: (
      conversationId: string,
      content: string,
      images: readonly InlineImageInput[] = [],
      replyToMessageId?: string
    ) => {
      const input: SendMessageInput = {
        content,
        images: [...images],
        replyToMessageId,
        clientId: createId(),
        timeZone: timeZone(),
      };
      return transport.request(
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
      images: readonly InlineImageInput[] = [],
      replyToMessageId?: string
    ) => {
      const input: SendMessageInput = {
        content,
        images: [...images],
        replyToMessageId,
        clientId: createId(),
        timeZone: timeZone(),
      };
      return transport.request(`/api/v0/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    reactToMessage: (messageId: string, emoji: string) => {
      const input: ReactToChannelMessageInput = {
        emoji,
        clientId: createId(),
        timeZone: timeZone(),
      };
      return transport.request(
        `/api/v0/channel-messages/${encodeURIComponent(messageId)}/reaction`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
    },
    resolveApproval: (approvalId: string, decision: ApprovalDecision) =>
      transport.request(`/api/v0/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision }),
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
    routines: (botId: string) =>
      transport.request<RoutineView[]>(`/api/v0/bots/${encodeURIComponent(botId)}/routines`),
    setRoutineEnabled: (routine: RoutineView, enabled: boolean) =>
      transport.request<RoutineView>(
        `/api/v0/routines/${encodeURIComponent(routine.id)}/${enabled ? "resume" : "pause"}`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: routine.revision, clientId: createId() }),
        }
      ),
    screenFrameUrl: (botId: string, revision = Date.now()) =>
      `${transport.baseUrl}/api/v0/bots/${encodeURIComponent(botId)}/screen/frame?v=${revision}`,
  };
};

export type OpenBotClient = ReturnType<typeof createOpenBotClient>;
