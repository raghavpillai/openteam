import { createOpenBotClient, selectMobileChannelRows } from "@openbot/client-core";
import type {
  AssetRef,
  ChannelMessageView,
  ClientSnapshot,
  ScreenActionInput,
  ScreenStatusView,
  SearchCategory,
  SearchResponse,
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
import { AppState, Linking } from "react-native";
import { getAuthToken, requireAuthentication } from "../auth";
import { mobileFixture } from "../fixtures";
import {
  listenForPushTokenChanges,
  type NotificationPermissionState,
  notificationPermissionState,
  setNotificationBadge,
  synchronizePushRegistration,
} from "../notifications";
import { searchClientSnapshot } from "../search";
import {
  loadServerConnection,
  saveServerConnection,
  type ServerConnectionConfig,
} from "../server-config";

interface OpenBotState {
  snapshot: ClientSnapshot;
  rows: ReturnType<typeof selectMobileChannelRows>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  isFixture: boolean;
  connection: ServerConnectionConfig;
  connectionLoaded: boolean;
  saveConnection: (input: ServerConnectionConfig) => Promise<void>;
  notificationPermission: NotificationPermissionState;
  notificationError: string | null;
  enableNotifications: () => Promise<void>;
  openNotificationSettings: () => Promise<void>;
  setBotNotifications: (botId: string, enabled: boolean) => Promise<void>;
  markChannelRead: (channelId: string) => Promise<void>;
  refresh: () => Promise<void>;
  search: (
    query: string,
    category?: SearchCategory,
    signal?: AbortSignal
  ) => Promise<SearchResponse>;
  sendMessage: (
    channelId: string,
    content: string,
    attachments?: readonly AssetRef[],
    replyToMessageId?: string
  ) => Promise<void>;
  uploadAsset: (input: {
    fileName: string;
    mimeType?: string;
    bytesBase64: string;
    alt?: string;
  }) => Promise<AssetRef>;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">, download?: boolean) => string | null;
  reactToMessage: (messageId: string, emoji: string) => Promise<void>;
  resolveApproval: (approvalId: string, decision: "accept" | "decline") => Promise<void>;
  screenStatus: (botId: string) => Promise<ScreenStatusView>;
  screenAction: (botId: string, input: ScreenActionInput) => Promise<ScreenStatusView>;
  setScreenTakeover: (botId: string, active: boolean) => Promise<ScreenStatusView>;
  screenFrameUrl: (botId: string, revision?: number) => string | null;
}

interface OutgoingMessage {
  localId: string;
  message: ChannelMessageView;
  pending: boolean;
  serverMessageId: string | null;
}

const messageMetadata = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const OpenBotContext = createContext<OpenBotState | null>(null);

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
  browserProfileScope: "computer",
  browserSessionScope: "computer",
  browserSessionMechanism: "shared-profiles",
});

export function OpenBotProvider({ children }: { children: React.ReactNode }) {
  const fixtureTakeovers = useRef(new Map<string, boolean>());
  const [connection, setConnection] = useState<ServerConnectionConfig>({
    serverUrl: "",
    accessToken: "",
  });
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  const client = useMemo(
    () =>
      connection.serverUrl
        ? createOpenBotClient({
            baseUrl: connection.serverUrl,
            accessToken: connection.accessToken || null,
            getAuthToken,
            onUnauthorized: requireAuthentication,
          })
        : null,
    [connection.accessToken, connection.serverUrl]
  );
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(mobileFixture);
  const [outgoingMessages, setOutgoingMessages] = useState<OutgoingMessage[]>([]);
  const snapshotRef = useRef(snapshot);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionState>("loading");
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const visibleSnapshot = useMemo<ClientSnapshot>(() => {
    const outgoingServerIds = new Set(
      outgoingMessages.flatMap(({ serverMessageId }) => (serverMessageId ? [serverMessageId] : []))
    );
    const authoritativeById = new Map(
      snapshot.channelMessages.map((message) => [message.id, message] as const)
    );
    const projectedOutgoing = outgoingMessages.map((outgoing) => {
      const message =
        (outgoing.serverMessageId ? authoritativeById.get(outgoing.serverMessageId) : undefined) ??
        outgoing.message;
      return {
        ...message,
        metadata: {
          ...messageMetadata(message),
          clientDelivery: {
            renderKey: outgoing.localId,
            state: outgoing.pending ? "pending" : "accepted",
          },
        },
      };
    });
    return {
      ...snapshot,
      channelMessages: [
        ...snapshot.channelMessages.filter((message) => !outgoingServerIds.has(message.id)),
        ...projectedOutgoing,
      ].sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
          left.id.localeCompare(right.id)
      ),
    };
  }, [outgoingMessages, snapshot]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    let active = true;
    void loadServerConnection()
      .then((loaded) => {
        if (!active) return;
        setConnection(loaded);
        setConnectionLoaded(true);
        if (!loaded.serverUrl) setLoading(false);
      })
      .catch((cause) => {
        if (!active) return;
        setConnectionLoaded(true);
        setLoading(false);
        setError(cause instanceof Error ? cause.message : "Could not load server settings");
      });
    return () => {
      active = false;
    };
  }, []);

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
  }, [client]);

  useEffect(() => {
    if (!connectionLoaded || !client) return;
    void setNotificationBadge(
      snapshot.channels.reduce((total, channel) => total + (channel.unreadCount ?? 0), 0)
    );
  }, [client, connectionLoaded, snapshot.channels]);

  useEffect(() => {
    if (connectionLoaded) void refresh();
  }, [connectionLoaded, refresh]);

  useEffect(() => {
    let active = true;
    const sync = async () => {
      try {
        const permission = client
          ? await synchronizePushRegistration(client, false)
          : await notificationPermissionState();
        if (active) {
          setNotificationPermission(permission);
          setNotificationError(null);
        }
      } catch (cause) {
        if (active) {
          setNotificationPermission(
            await notificationPermissionState().catch(
              (): NotificationPermissionState => "unavailable"
            )
          );
          setNotificationError(
            cause instanceof Error ? cause.message : "Could not register for notifications"
          );
        }
      }
    };
    void sync();
    const tokenSubscription = client
      ? listenForPushTokenChanges(client, (cause) => {
          if (active) {
            setNotificationError(
              cause instanceof Error ? cause.message : "Could not refresh the push token"
            );
          }
        })
      : null;
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void refresh();
      void sync();
    });
    return () => {
      active = false;
      tokenSubscription?.remove();
      appStateSubscription.remove();
    };
  }, [client]);

  const saveConnection = useCallback(async (input: ServerConnectionConfig) => {
    const saved = await saveServerConnection(input);
    setLoading(Boolean(saved.serverUrl));
    setError(null);
    setConnection(saved);
  }, []);

  const markChannelRead = useCallback(
    async (channelId: string) => {
      const latestSequence = snapshotRef.current.channelMessages
        .filter((message) => message.channelId === channelId && /^\d+$/.test(message.sequence))
        .reduce<bigint | null>((latest, message) => {
          const sequence = BigInt(message.sequence);
          return latest === null || sequence > latest ? sequence : latest;
        }, null);
      setSnapshot((current) => ({
        ...current,
        channels: current.channels.map((channel) =>
          channel.id === channelId ? { ...channel, unreadCount: 0 } : channel
        ),
      }));
      if (!client) return;
      await client.markChannelRead(channelId, latestSequence?.toString());
      await refresh();
    },
    [client, refresh]
  );

  const enableNotifications = useCallback(async () => {
    setNotificationError(null);
    if (!client) {
      setNotificationError("Connect OpenBot to a server before enabling push notifications.");
      return;
    }
    try {
      setNotificationPermission(await synchronizePushRegistration(client, true));
    } catch (cause) {
      setNotificationError(
        cause instanceof Error ? cause.message : "Could not enable push notifications"
      );
      setNotificationPermission(
        await notificationPermissionState().catch((): NotificationPermissionState => "unavailable")
      );
    }
  }, [client]);

  const openNotificationSettings = useCallback(() => Linking.openSettings(), []);

  const setBotNotifications = useCallback(
    async (botId: string, enabled: boolean) => {
      const previous = snapshot.bots.find((bot) => bot.id === botId)?.notificationsEnabled;
      setSnapshot((current) => ({
        ...current,
        bots: current.bots.map((bot) =>
          bot.id === botId ? { ...bot, notificationsEnabled: enabled } : bot
        ),
      }));
      if (!client) return;
      try {
        await client.updateBot(botId, { notificationsEnabled: enabled });
        await refresh();
      } catch (cause) {
        if (previous !== undefined) {
          setSnapshot((current) => ({
            ...current,
            bots: current.bots.map((bot) =>
              bot.id === botId ? { ...bot, notificationsEnabled: previous } : bot
            ),
          }));
        }
        throw cause;
      }
    },
    [client, refresh, snapshot.bots]
  );

  const search = useCallback(
    (query: string, category: SearchCategory = "all", signal?: AbortSignal) =>
      client
        ? client.search(query, category, signal)
        : Promise.resolve(searchClientSnapshot(snapshot, query, category)),
    [client, snapshot]
  );

  const sendMessage = useCallback(
    async (
      channelId: string,
      content: string,
      attachments: readonly AssetRef[] = [],
      replyToMessageId?: string
    ) => {
      const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimistic: ChannelMessageView = {
        id: optimisticId,
        sequence: optimisticId,
        channelId,
        sender: "user",
        senderBotId: null,
        sourceRunId: null,
        content,
        metadata: {
          ...(attachments.length ? { attachments: [...attachments] } : {}),
          ...(replyToMessageId ? { replyTo: replyToMessageId } : {}),
        },
        createdAt: new Date().toISOString(),
      };
      setOutgoingMessages((current) => [
        ...current,
        {
          localId: optimisticId,
          message: optimistic,
          pending: true,
          serverMessageId: null,
        },
      ]);
      if (!client) {
        setOutgoingMessages((current) =>
          current.map((candidate) =>
            candidate.localId === optimisticId ? { ...candidate, pending: false } : candidate
          )
        );
        return;
      }
      try {
        const channel = snapshot.channels.find((candidate) => candidate.id === channelId);
        const botId = channel?.kind === "bot_dm" ? channel.members[0]?.botId : null;
        const conversationId = botId
          ? snapshot.bots.find((candidate) => candidate.id === botId)?.conversationId
          : null;
        const accepted = conversationId
          ? await client.sendDirectMessage(conversationId, content, attachments, replyToMessageId)
          : await client.sendChannelMessage(channelId, content, attachments, replyToMessageId);
        setOutgoingMessages((current) =>
          current.map((candidate) =>
            candidate.localId === optimisticId
              ? {
                  ...candidate,
                  message: accepted.message,
                  pending: false,
                  serverMessageId: accepted.message.id,
                }
              : candidate
          )
        );
        await refresh();
      } catch (cause) {
        setOutgoingMessages((current) =>
          current.filter((candidate) => candidate.localId !== optimisticId)
        );
        throw cause;
      }
    },
    [client, refresh, snapshot.bots, snapshot.channels]
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
    [client, refresh]
  );

  const uploadAsset = useCallback(
    (input: { fileName: string; mimeType?: string; bytesBase64: string; alt?: string }) => {
      if (!client) throw new Error("Connect OpenBot before uploading files.");
      return client.uploadAsset(input);
    },
    [client]
  );

  const assetUrl = useCallback(
    (asset: Pick<AssetRef, "assetId" | "fileName">, download = false) =>
      client?.assetUrl(asset, download) ?? null,
    [client]
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
    [client, refresh]
  );

  const screenStatus = useCallback(
    async (botId: string) => {
      return client
        ? client.screenStatus(botId)
        : fixtureScreenStatus(botId, fixtureTakeovers.current.get(botId) ?? false);
    },
    [client]
  );

  const screenAction = useCallback(
    async (botId: string, input: ScreenActionInput) => {
      return client
        ? client.screenAction(botId, input)
        : fixtureScreenStatus(botId, fixtureTakeovers.current.get(botId) ?? false);
    },
    [client]
  );

  const setScreenTakeover = useCallback(
    async (botId: string, active: boolean) => {
      fixtureTakeovers.current.set(botId, active);
      return client ? client.setScreenTakeover(botId, active) : fixtureScreenStatus(botId, active);
    },
    [client]
  );

  const screenFrameUrl = useCallback(
    (botId: string, revision = Date.now()) =>
      client ? client.screenFrameUrl(botId, revision) : null,
    [client]
  );

  const value = useMemo<OpenBotState>(
    () => ({
      snapshot: visibleSnapshot,
      rows: selectMobileChannelRows(visibleSnapshot),
      loading,
      refreshing,
      error,
      isFixture: !client,
      connection,
      connectionLoaded,
      saveConnection,
      notificationPermission,
      notificationError,
      enableNotifications,
      openNotificationSettings,
      setBotNotifications,
      markChannelRead,
      refresh,
      search,
      sendMessage,
      uploadAsset,
      assetUrl,
      reactToMessage,
      resolveApproval,
      screenStatus,
      screenAction,
      setScreenTakeover,
      screenFrameUrl,
    }),
    [
      error,
      connection,
      connectionLoaded,
      enableNotifications,
      assetUrl,
      loading,
      markChannelRead,
      notificationError,
      notificationPermission,
      openNotificationSettings,
      reactToMessage,
      refresh,
      refreshing,
      resolveApproval,
      search,
      saveConnection,
      screenAction,
      screenFrameUrl,
      screenStatus,
      setBotNotifications,
      sendMessage,
      uploadAsset,
      setScreenTakeover,
      visibleSnapshot,
    ]
  );

  return <OpenBotContext.Provider value={value}>{children}</OpenBotContext.Provider>;
}

export const useOpenBot = (): OpenBotState => {
  const value = useContext(OpenBotContext);
  if (!value) throw new Error("useOpenBot must be used inside OpenBotProvider");
  return value;
};
