import { createOpenBotClient, selectMobileChannelRows } from "@openbot/client-core";
import type {
  ChannelMessageView,
  ClientSnapshot,
  InlineImageInput,
  ScreenActionInput,
  ScreenStatusView,
} from "@openbot/contracts";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mobileFixture } from "../fixtures";
import { getAuthToken, requireAuthentication, serverUrl } from "../auth";

interface OpenBotState {
  snapshot: ClientSnapshot;
  rows: ReturnType<typeof selectMobileChannelRows>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  isFixture: boolean;
  refresh: () => Promise<void>;
  sendMessage: (
    channelId: string,
    content: string,
    images?: readonly InlineImageInput[],
    replyToMessageId?: string
  ) => Promise<void>;
  reactToMessage: (messageId: string, emoji: string) => Promise<void>;
  resolveApproval: (approvalId: string, decision: "accept" | "decline") => Promise<void>;
  screenStatus: (botId: string) => Promise<ScreenStatusView>;
  screenAction: (botId: string, input: ScreenActionInput) => Promise<ScreenStatusView>;
  setScreenTakeover: (botId: string, active: boolean) => Promise<ScreenStatusView>;
  screenFrameUrl: (botId: string, revision?: number) => string | null;
}

const OpenBotContext = createContext<OpenBotState | null>(null);

const client = serverUrl
  ? createOpenBotClient({
      baseUrl: serverUrl,
      getAuthToken,
      onUnauthorized: requireAuthentication,
    })
  : null;

const fixtureScreenStatus = (botId: string, humanTakeover = false): ScreenStatusView => ({
  botId,
  state: "ready",
  width: 1280,
  height: 800,
  display: 100,
  viewerUrl: "",
  humanTakeover,
  agentInputPaused: humanTakeover,
  apps: ["chromium", "thunar", "terminal"],
  browserProfileScope: "bot",
  browserSessionScope: "computer",
  browserSessionMechanism: "cookie-broker",
});

export function OpenBotProvider({ children }: { children: React.ReactNode }) {
  const fixtureTakeovers = useRef(new Map<string, boolean>());
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(mobileFixture);
  const [loading, setLoading] = useState(Boolean(client));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    try {
      setSnapshot(await client.snapshot());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach OpenBot");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sendMessage = useCallback(
    async (
      channelId: string,
      content: string,
      images: readonly InlineImageInput[] = [],
      replyToMessageId?: string
    ) => {
      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: ChannelMessageView = {
        id: optimisticId,
        sequence: optimisticId,
        channelId,
        sender: "user",
        senderBotId: null,
        sourceRunId: null,
        content,
        metadata: {
          ...(images.length ? { images: [...images] } : {}),
          ...(replyToMessageId ? { replyTo: replyToMessageId } : {}),
        },
        createdAt: new Date().toISOString(),
      };
      setSnapshot((current) => ({
        ...current,
        channelMessages: [...current.channelMessages, optimistic],
      }));
      if (!client) return;
      try {
        const channel = snapshot.channels.find((candidate) => candidate.id === channelId);
        const botId = channel?.kind === "bot_dm" ? channel.members[0]?.botId : null;
        const conversationId = botId
          ? snapshot.bots.find((candidate) => candidate.id === botId)?.conversationId
          : null;
        if (conversationId) {
          await client.sendDirectMessage(conversationId, content, images, replyToMessageId);
        } else {
          await client.sendChannelMessage(channelId, content, images, replyToMessageId);
        }
        await refresh();
      } catch (cause) {
        setSnapshot((current) => ({
          ...current,
          channelMessages: current.channelMessages.filter((message) => message.id !== optimisticId),
        }));
        throw cause;
      }
    },
    [refresh, snapshot.bots, snapshot.channels]
  );

  const reactToMessage = useCallback(
    async (messageId: string, emoji: string) => {
      setSnapshot((current) => ({
        ...current,
        channelMessages: current.channelMessages.map((message) => {
          if (message.id !== messageId) return message;
          const metadata =
            message.metadata &&
            typeof message.metadata === "object" &&
            !Array.isArray(message.metadata)
              ? message.metadata
              : {};
          const reactions = Array.isArray((metadata as { reactions?: unknown }).reactions)
            ? ([...(metadata as { reactions: unknown[] }).reactions] as unknown[])
            : [];
          return {
            ...message,
            metadata: { ...metadata, reactions: [...reactions, { by: "me", emoji }] },
          };
        }),
      }));
      if (!client) return;
      await client.reactToMessage(messageId, emoji);
      await refresh();
    },
    [refresh]
  );

  const resolveApproval = useCallback(
    async (approvalId: string, decision: "accept" | "decline") => {
      if (client) await client.resolveApproval(approvalId, decision);
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId
            ? { ...approval, status: decision === "accept" ? "accepted" : "declined" }
            : approval
        ),
      }));
      if (client) await refresh();
    },
    [refresh]
  );

  const screenStatus = useCallback(async (botId: string) => {
    return client
      ? client.screenStatus(botId)
      : fixtureScreenStatus(botId, fixtureTakeovers.current.get(botId) ?? false);
  }, []);

  const screenAction = useCallback(async (botId: string, input: ScreenActionInput) => {
    return client
      ? client.screenAction(botId, input)
      : fixtureScreenStatus(botId, fixtureTakeovers.current.get(botId) ?? false);
  }, []);

  const setScreenTakeover = useCallback(async (botId: string, active: boolean) => {
    fixtureTakeovers.current.set(botId, active);
    return client ? client.setScreenTakeover(botId, active) : fixtureScreenStatus(botId, active);
  }, []);

  const screenFrameUrl = useCallback((botId: string, revision = Date.now()) => {
    return client ? client.screenFrameUrl(botId, revision) : null;
  }, []);

  const value = useMemo<OpenBotState>(
    () => ({
      snapshot,
      rows: selectMobileChannelRows(snapshot),
      loading,
      refreshing,
      error,
      isFixture: !client,
      refresh,
      sendMessage,
      reactToMessage,
      resolveApproval,
      screenStatus,
      screenAction,
      setScreenTakeover,
      screenFrameUrl,
    }),
    [
      error,
      loading,
      reactToMessage,
      refresh,
      refreshing,
      resolveApproval,
      screenAction,
      screenFrameUrl,
      screenStatus,
      sendMessage,
      setScreenTakeover,
      snapshot,
    ]
  );

  return <OpenBotContext.Provider value={value}>{children}</OpenBotContext.Provider>;
}

export const useOpenBot = (): OpenBotState => {
  const value = useContext(OpenBotContext);
  if (!value) throw new Error("useOpenBot must be used inside OpenBotProvider");
  return value;
};
