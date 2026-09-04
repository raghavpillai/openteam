import {
  createKeyedRequestCoordinator,
  MAX_PARALLEL_UPLOADS,
  mapWithConcurrency,
  operationLeaseIsCurrent,
} from "@openteam/client-core/async";
import { createOpenTeamClient } from "@openteam/client-core/client";
import {
  CommittedEventCursor,
  createLiveSyncController,
  LIVE_SYNC_DEBOUNCE_MS,
  RUNTIME_REFRESH_MS,
  reconnectDelay,
  shouldRefreshForEvent,
  synchronizeClientSnapshot,
} from "@openteam/client-core/sync";
import type {
  AssetRef,
  BotView,
  ChannelClientState,
  ChannelMessageView,
  ChannelView,
  ClientBootstrapView,
  ClientCapabilities,
  ClientSnapshot,
  CreateRoutineInput,
  PluginBotAccessView,
  PluginSettingsView,
  RoutineExecutionView,
  RoutineView,
  ScreenActionInput,
  ScreenStatusView,
  SearchCategory,
  SearchResponse,
  SidebarPreferences,
  UpdateBotInput,
  UpdateRoutineInput,
} from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import {
  emptySidebarPreferences,
  sidebarPreferencesFromRootSettings,
  toggleSidebarPinned,
} from "@openteam/contracts/client-preferences";
import {
  createChannelHistoryStore,
  MESSAGE_HISTORY_PAGE_SIZE,
} from "@openteam/product-core/channel-history";
import {
  classifyDurableSendError,
  createDurableSendController,
  type DurableSendController,
  type DurableSendPayload,
  type DurableSendRecord,
  durableSendMessage,
  durableSendVisualState,
  type MessageDeliveryAcceptance,
  messageDeliveryAcceptance,
} from "@openteam/product-core/durable-delivery";
import {
  latestNumericSequence,
  mergeBootstrapWithHistory,
  mergeChannelMessages,
  mergeChannelState,
  retainedHistoryIds,
  sortedUniqueMessages,
  touchHistoryLru,
  trimInactiveHistories,
} from "@openteam/product-core/history";
import { messageMetadata, toggleOwnReaction } from "@openteam/product-core/messages";
import { projectOutgoingMessages } from "@openteam/product-core/outgoing-messages";
import {
  createReadReceiptController,
  readReceiptTarget,
} from "@openteam/product-core/read-receipts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { selectChannelRows } from "@openteam/product-core/snapshot";
import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
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
import {
  configureAuthServer,
  getAuthAccountIdForServer,
  getAuthTokenForServer,
  onBeforeSignOut,
  requireAuthenticationForServer,
} from "../auth";
import { recordMobileDeliveryTelemetry } from "../delivery-telemetry";
import { clearConversationDraftIfCurrent } from "../drafts";
import {
  discardMobileDeliveryAttachments,
  mobileDeliveryAttachmentUri,
} from "../durable-attachment-stage";
import { createMobileDurableSendStorage } from "../durable-send-storage";
import { mobileFixture } from "../fixtures";
import { uploadNativeAsset } from "../native-asset-upload";
import {
  listenForPushTokenChanges,
  type NotificationPermissionState,
  notificationPermissionState,
  setNotificationBadge,
  synchronizePushRegistration,
  unregisterPushInstallation,
} from "../notifications";
import { coordinatePushRetirement } from "../push-retirement";
import { searchClientSnapshot } from "../search";
import {
  loadServerConnection,
  normalizeServerConnection,
  type ServerConnectionConfig,
  saveServerConnection,
} from "../server-config";
import {
  flushCachedSnapshotWrites,
  loadCachedSnapshot,
  scheduleCachedSnapshotSave,
} from "../snapshot-cache";

interface OpenTeamState {
  snapshot: ClientSnapshot;
  capabilities: ClientCapabilities;
  hiddenBots: BotView[];
  rows: ReturnType<typeof selectChannelRows>;
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
  createBot: (name: string) => Promise<string>;
  duplicateBot: (botId: string) => Promise<string>;
  archiveBot: (botId: string) => Promise<void>;
  createGroup: (name: string, botIds: string[]) => Promise<string>;
  updateBot: (botId: string, input: UpdateBotInput) => Promise<BotView>;
  sidebarPreferences: SidebarPreferences;
  updateSidebarPreferences: (preferences: SidebarPreferences) => Promise<void>;
  togglePinned: (channelId: string) => Promise<void>;
  setBotHidden: (botId: string, hidden: boolean) => Promise<void>;
  setChannelHidden: (channelId: string, hidden: boolean) => Promise<void>;
  deleteGroup: (channelId: string) => Promise<void>;
  renameChannel: (channelId: string, name: string) => Promise<ChannelView>;
  updateChannelProfile: (
    channelId: string,
    name: string,
    description: string
  ) => Promise<ChannelView>;
  setChannelMembers: (channelId: string, botIds: string[]) => Promise<ChannelView>;
  routines: (ownerId: string, ownerKind?: "bot" | "group") => Promise<RoutineView[]>;
  routine: (routineId: string) => Promise<RoutineView>;
  createRoutine: (
    ownerId: string,
    ownerKind: "bot" | "group",
    input: CreateRoutineInput
  ) => Promise<RoutineView>;
  updateRoutine: (routineId: string, input: UpdateRoutineInput) => Promise<RoutineView>;
  setRoutineEnabled: (routine: RoutineView, enabled: boolean) => Promise<RoutineView>;
  deleteRoutine: (routine: RoutineView) => Promise<void>;
  runRoutineNow: (routineId: string) => Promise<RoutineExecutionView>;
  routineExecutions: (routineId: string, limit?: number) => Promise<RoutineExecutionView[]>;
  pluginSettings: () => Promise<PluginSettingsView>;
  pluginBotAccess: (
    pluginKey: string,
    query?: { query?: string; offset?: number; limit?: number; signal?: AbortSignal }
  ) => Promise<PluginBotAccessView>;
  installPlugin: (pluginKey: string, values?: Record<string, string>) => Promise<void>;
  uninstallPlugin: (pluginKey: string) => Promise<void>;
  setPluginEnablement: (
    pluginKey: string,
    botId: string,
    enabled: boolean,
    skillsEnabled?: boolean
  ) => Promise<void>;
  setPluginGrant: (connectionId: string, botId: string, enabled: boolean) => Promise<void>;
  connectPlugin: (connectionId: string) => Promise<void>;
  disconnectPlugin: (connectionId: string) => Promise<void>;
  authenticatePlugin: (connectionId: string) => Promise<string>;
  markChannelRead: (channelId: string, throughSequence?: string) => Promise<void>;
  refresh: () => Promise<void>;
  hydrateChannel: (channelId: string, targetMessageId?: string) => Promise<void>;
  releaseChannel: (channelId: string) => void;
  loadEarlierMessages: (channelId: string) => Promise<void>;
  loadLaterMessages: (channelId: string) => Promise<void>;
  jumpToLatestMessages: (channelId: string) => Promise<void>;
  setHistoryViewport: (channelId: string, messageIds: readonly string[], atBottom: boolean) => void;
  visibleHistoryMessageIds: (channelId: string) => ReadonlySet<string> | null;
  historyState: Record<
    string,
    { beforeSequence: string | null; hasMore: boolean; loading: boolean; hasNewer?: boolean }
  >;
  search: (
    query: string,
    category?: SearchCategory,
    signal?: AbortSignal
  ) => Promise<SearchResponse>;
  sendMessage: (
    channelId: string,
    content: string,
    attachments?: readonly AssetRef[],
    replyToMessageId?: string,
    options?: {
      isFork?: boolean;
      consumedDraft?: { key: string; id: string };
      stagedAttachments?: DurableSendPayload["stagedAttachments"];
    }
  ) => Promise<void>;
  resendFailedMessage: (nonce: string) => Promise<void>;
  deleteFailedMessage: (nonce: string) => Promise<void>;
  cancelQueuedMessage: (nonce: string) => Promise<DurableSendPayload | null>;
  deliveryRecoveries: readonly DurableSendRecord[];
  acknowledgeDeliveryRecovery: (nonce: string) => Promise<void>;
  uploadAsset: (input: {
    uri: string;
    fileName: string;
    mimeType?: string;
    alt?: string;
    signal?: AbortSignal;
    onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void;
  }) => Promise<AssetRef>;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">, download?: boolean) => string | null;
  reactToMessage: (messageId: string, emoji: string) => Promise<void>;
  respondToWidget: (messageId: string, value: string) => Promise<boolean>;
  dismissWidget: (messageId: string) => Promise<boolean>;
  submitSecret: (messageId: string, value: string) => Promise<boolean>;
  mutateComputerHandoff: (
    messageId: string,
    action: "start" | "complete" | "skip" | "dismiss"
  ) => Promise<boolean>;
  resolveApproval: (approvalId: string, decision: "accept" | "decline") => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  screenStatus: (botId: string) => Promise<ScreenStatusView>;
  screenAction: (botId: string, input: ScreenActionInput) => Promise<ScreenStatusView>;
  setScreenTakeover: (botId: string, active: boolean) => Promise<ScreenStatusView>;
  screenFrameUrl: (botId: string, revision?: number) => string | null;
}

const OpenTeamContext = createContext<OpenTeamState | null>(null);
const PUSH_UNREGISTER_TIMEOUT_MS = 1_500;
type MobileClient = ReturnType<typeof createOpenTeamClient>;

const mutationId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `ios-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const durableAccountScope = (serverUrl: string): string => {
  const credential =
    getAuthAccountIdForServer(serverUrl) ?? getAuthTokenForServer(serverUrl) ?? "local";
  let hash = 0xcbf29ce484222325n;
  for (const character of `${serverUrl}:${credential}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `mobile:${serverUrl}:${hash.toString(16).padStart(16, "0")}`;
};

const emptyRemoteSnapshot = (): ClientSnapshot => ({
  ...mobileFixture,
  cursor: "0",
  bots: [],
  channels: [],
  channelMessages: [],
  channelRounds: [],
  runs: [],
  runItems: [],
  approvals: [],
  subagents: [],
});

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
  browserStateCoverage: [
    "cookies",
    "local-storage",
    "session-storage",
    "indexed-db",
    "service-workers",
    "cache-storage",
    "extensions",
    "saved-passwords",
    "client-certificates",
    "settings",
    "bookmarks",
    "history",
    "open-tabs",
  ],
  browserTargetRouting: "bot-owned-tabs",
});

export function OpenTeamProvider({ children }: { children: React.ReactNode }) {
  const fixtureTakeovers = useRef(new Map<string, boolean>());
  const [connection, setConnection] = useState<ServerConnectionConfig>({ serverUrl: "" });
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  const candidateClient = useMemo(() => {
    const serverUrl = connection.serverUrl;
    return serverUrl
      ? createOpenTeamClient({
          baseUrl: serverUrl,
          fetch: expoFetch as unknown as typeof fetch,
          eventTransport: "long-poll",
          getAuthToken: () => getAuthTokenForServer(serverUrl),
          onUnauthorized: (usedToken) => requireAuthenticationForServer(serverUrl, usedToken),
        })
      : null;
  }, [connection.serverUrl]);
  const [readyClient, setReadyClient] = useState<MobileClient | null>(null);
  const client = readyClient === candidateClient ? candidateClient : null;
  const sendTransportDownUntilMsRef = useRef(0);
  const [sendTransportRevision, setSendTransportRevision] = useState(0);
  const sendController = useMemo<DurableSendController | null>(() => {
    if (!client) return null;
    // Keep journals isolated across accounts without ever writing a bearer to disk.
    const scope = durableAccountScope(client.baseUrl);
    const markTransportUp = () => {
      if (sendTransportDownUntilMsRef.current === 0) return;
      sendTransportDownUntilMsRef.current = 0;
      setSendTransportRevision((revision) => revision + 1);
    };
    const resolveAcceptance = async (
      record: DurableSendRecord
    ): Promise<MessageDeliveryAcceptance> => {
      const status = await client.messageDeliveryStatus(record.target.channelId, record.nonce);
      markTransportUp();
      return messageDeliveryAcceptance(status);
    };
    return createDurableSendController(scope, createMobileDurableSendStorage(scope), {
      createNonce: mutationId,
      classifyError: (cause) => {
        const disposition = classifyDurableSendError(cause);
        if (disposition === "offline") {
          sendTransportDownUntilMsRef.current = Date.now() + 5_000;
          setSendTransportRevision((revision) => revision + 1);
        }
        return disposition;
      },
      isTransportDown: () =>
        AppState.currentState !== "active" || Date.now() < sendTransportDownUntilMsRef.current,
      onTelemetry: recordMobileDeliveryTelemetry,
      commitStagedAttachments: async (record) => {
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 120_000);
        try {
          const uploadToken = getAuthTokenForServer(client.baseUrl);
          return await mapWithConcurrency(
            record.payload.stagedAttachments ?? [],
            MAX_PARALLEL_UPLOADS,
            async (attachment) => {
              try {
                const uri = mobileDeliveryAttachmentUri(attachment.stagingId);
                const info = await LegacyFileSystem.getInfoAsync(uri);
                if (!info.exists) {
                  throw Object.assign(new Error("The staged attachment is no longer available."), {
                    code: "staged_attachment_missing",
                    status: 422,
                  });
                }
                return await uploadNativeAsset({
                  serverUrl: client.baseUrl,
                  file: new File(uri),
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType,
                  alt: attachment.alt,
                  authToken: uploadToken,
                  signal: controller.signal,
                  onUnauthorized: () => requireAuthenticationForServer(client.baseUrl, uploadToken),
                });
              } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                if (/network|offline|internet|connection|not connected/i.test(message)) {
                  throw Object.assign(cause instanceof Error ? cause : new Error(message), {
                    code: "offline",
                    status: 0,
                  });
                }
                throw cause;
              }
            }
          );
        } catch (cause) {
          if (timedOut) {
            throw Object.assign(new Error("Attachment upload timed out."), {
              code: "attachment_commit_timeout",
              status: 422,
            });
          }
          throw cause;
        } finally {
          clearTimeout(timeout);
        }
      },
      discardStagedAttachments: discardMobileDeliveryAttachments,
      resolveAcceptance,
      dispatch: async (record) => {
        const { payload, target } = record;
        const options = {
          ...(payload.richText ? { richText: payload.richText } : {}),
          ...(payload.isFork !== undefined ? { isFork: payload.isFork } : {}),
          clientId: record.nonce,
        };
        const accepted = target.conversationId
          ? await client.sendDirectMessage(
              target.conversationId,
              payload.content,
              payload.attachments,
              payload.replyToMessageId,
              options
            )
          : await client.sendChannelMessage(
              target.channelId,
              payload.content,
              payload.attachments,
              payload.replyToMessageId,
              options
            );
        markTransportUp();
        return { message: accepted.message };
      },
    });
  }, [client]);
  const retiringPushClientsRef = useRef(new WeakSet<MobileClient>());
  const activeClientRef = useRef(client);
  activeClientRef.current = client && !retiringPushClientsRef.current.has(client) ? client : null;
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(mobileFixture);
  const [capabilities, setCapabilities] = useState<ClientCapabilities>(CLIENT_CAPABILITIES);
  const [hiddenBots, setHiddenBots] = useState<BotView[]>([]);
  const [sidebarPreferences, setSidebarPreferences] =
    useState<SidebarPreferences>(emptySidebarPreferences);
  const sidebarPreferencesRef = useRef(sidebarPreferences);
  const [durableSends, setDurableSends] = useState<readonly DurableSendRecord[]>([]);
  const [deliveryRecoveries, setDeliveryRecoveries] = useState<readonly DurableSendRecord[]>([]);
  const snapshotRef = useRef(snapshot);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionState>("loading");
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<
    Record<
      string,
      { beforeSequence: string | null; hasMore: boolean; loading: boolean; hasNewer?: boolean }
    >
  >({});
  const connectionEpochRef = useRef(0);
  const connectionUrlRef = useRef("");
  const remoteAcceptedEpochRef = useRef(-1);
  const eventCursorRef = useRef(new CommittedEventCursor());
  const [syncReadyEpoch, setSyncReadyEpoch] = useState<number | null>(null);
  const activeHistoryChannelId = useRef<string | null>(null);
  const inactiveHistoryLru = useRef<string[]>([]);
  const hydrationRequests = useRef(createKeyedRequestCoordinator());
  const historyStore = useRef(createChannelHistoryStore());
  const readReceipts = useRef(createReadReceiptController());
  const lastBadgeCountRef = useRef<number | null>(null);
  const syncRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRetryAttemptRef = useRef(0);
  const syncRemoteCallbackRef = useRef<(() => Promise<void>) | null>(null);
  const deferredHistorySyncs = useRef(new WeakSet<Promise<unknown>>());
  const pushOperationsRef = useRef(new Map<MobileClient, Set<Promise<unknown>>>());
  const acceptedSendRefreshesRef = useRef(new Set<string>());

  const operationIsCurrent = useCallback((operationClient: MobileClient, epoch: number) => {
    return operationLeaseIsCurrent(activeClientRef.current, connectionEpochRef.current, {
      client: operationClient,
      epoch,
    });
  }, []);
  const pushOperationIsCurrent = useCallback(
    (operationClient: MobileClient) =>
      activeClientRef.current === operationClient &&
      !retiringPushClientsRef.current.has(operationClient),
    []
  );
  const trackPushOperation = useCallback(
    (operationClient: MobileClient, operation: Promise<unknown>): void => {
      const operations = pushOperationsRef.current.get(operationClient) ?? new Set();
      operations.add(operation);
      pushOperationsRef.current.set(operationClient, operations);
      const remove = () => {
        operations.delete(operation);
        if (operations.size === 0) pushOperationsRef.current.delete(operationClient);
      };
      void operation.then(remove, remove);
    },
    []
  );
  const beginClientRetirement = useCallback((operationClient: MobileClient): void => {
    retiringPushClientsRef.current.add(operationClient);
    if (activeClientRef.current === operationClient) activeClientRef.current = null;
    connectionEpochRef.current += 1;
    setRefreshing(false);
  }, []);
  const retirePushClient = useCallback(async (operationClient: MobileClient): Promise<void> => {
    retiringPushClientsRef.current.add(operationClient);
    const cleanupToken = getAuthTokenForServer(operationClient.baseUrl);
    const cleanupClient = createOpenTeamClient({
      baseUrl: operationClient.baseUrl,
      fetch: expoFetch as unknown as typeof fetch,
      getAuthToken: () => cleanupToken,
    });
    const pending = [...(pushOperationsRef.current.get(operationClient) ?? [])];
    const retirement = coordinatePushRetirement(
      pending,
      () => unregisterPushInstallation(cleanupClient),
      PUSH_UNREGISTER_TIMEOUT_MS
    );
    void retirement.eventual.catch(() => undefined);
    await retirement.bounded;
  }, []);

  const acceptRemoteSnapshot = useCallback(
    (next: ClientSnapshot, epoch = connectionEpochRef.current, persist = true): boolean => {
      if (epoch !== connectionEpochRef.current) return false;
      const activeChannel = activeHistoryChannelId.current;
      const retained = activeChannel ? historyStore.current.retained(activeChannel) : null;
      if (retained)
        next = {
          ...next,
          channelMessages: sortedUniqueMessages([
            ...next.channelMessages.filter((message) => message.channelId !== activeChannel),
            ...retained,
          ]),
        };
      snapshotRef.current = next;
      setSnapshot(next);
      if (persist && connectionUrlRef.current) {
        scheduleCachedSnapshotSave(connectionUrlRef.current, next, [
          ...(activeHistoryChannelId.current ? [activeHistoryChannelId.current] : []),
          ...inactiveHistoryLru.current,
        ]);
      }
      return true;
    },
    []
  );
  const setHistoryViewport = useCallback(
    (channelId: string, messageIds: readonly string[], atBottom: boolean) => {
      historyStore.current.setViewport(channelId, messageIds, atBottom);
    },
    []
  );
  const visibleHistoryMessageIds = useCallback((channelId: string): ReadonlySet<string> | null => {
    return historyStore.current.visibleIds(channelId);
  }, []);
  const publishHistory = useCallback(
    (channelId: string, epoch = connectionEpochRef.current) => {
      if (epoch !== connectionEpochRef.current || channelId !== activeHistoryChannelId.current)
        return;
      const status = historyStore.current.status(channelId);
      if (!status) return;
      // acceptRemoteSnapshot already merges the active retained window. Doing
      // the same full snapshot sort here doubled this work for every page.
      acceptRemoteSnapshot(snapshotRef.current, epoch);
      setHistoryState((current) => {
        const previous = current[channelId];
        return previous &&
          !previous.loading &&
          previous.beforeSequence === status.beforeSequence &&
          previous.hasMore === status.hasMore &&
          previous.hasNewer === status.hasNewer
          ? current
          : { ...current, [channelId]: { ...status, loading: false } };
      });
    },
    [acceptRemoteSnapshot]
  );
  const acceptRemoteBootstrap = useCallback(
    (bootstrap: ClientBootstrapView, epoch = connectionEpochRef.current): boolean => {
      if (epoch !== connectionEpochRef.current) return false;
      if (!eventCursorRef.current.commit(bootstrap.cursor)) return false;
      setCapabilities(bootstrap.capabilities ?? CLIENT_CAPABILITIES);
      const activeChannel = activeHistoryChannelId.current;
      if (activeChannel && !bootstrap.channels.some((channel) => channel.id === activeChannel)) {
        historyStore.current.delete(activeChannel);
        hydrationRequests.current.invalidate(activeChannel);
      }
      const retained = retainedHistoryIds(
        activeHistoryChannelId.current,
        inactiveHistoryLru.current
      );
      const next = trimInactiveHistories(
        mergeBootstrapWithHistory(bootstrap, snapshotRef.current, retained),
        activeHistoryChannelId.current,
        inactiveHistoryLru.current
      );
      remoteAcceptedEpochRef.current = epoch;
      setSyncReadyEpoch(epoch);
      return acceptRemoteSnapshot(next, epoch);
    },
    [acceptRemoteSnapshot]
  );
  const acceptChannelMessages = useCallback(
    (
      channelId: string,
      messages: readonly ChannelMessageView[],
      epoch = connectionEpochRef.current
    ): boolean => {
      if (epoch !== connectionEpochRef.current) return false;
      return acceptRemoteSnapshot(
        trimInactiveHistories(
          mergeChannelMessages(snapshotRef.current, channelId, messages),
          activeHistoryChannelId.current,
          inactiveHistoryLru.current
        ),
        epoch
      );
    },
    [acceptRemoteSnapshot]
  );
  const acceptChannelState = useCallback(
    (state: ChannelClientState, epoch = connectionEpochRef.current): boolean => {
      if (epoch !== connectionEpochRef.current) return false;
      return acceptRemoteSnapshot(mergeChannelState(snapshotRef.current, state), epoch);
    },
    [acceptRemoteSnapshot]
  );
  const visibleSnapshot = useMemo<ClientSnapshot>(() => {
    if (durableSends.length === 0) return snapshot;
    const projected = projectOutgoingMessages(snapshot.channelMessages, durableSends, {
      echoRenderKey: "delivery",
      orderBy: "messageId",
    });
    return {
      ...snapshot,
      channelMessages: projected.map(({ message, delivery, renderKey, pending }) =>
        delivery
          ? {
              ...message,
              metadata: {
                ...messageMetadata(message),
                clientDelivery: {
                  renderKey,
                  nonce: delivery.nonce,
                  state: durableSendVisualState(delivery),
                  inFlight: pending,
                  composedAtMs: delivery.queuedAtMs,
                  queuedAtMs: delivery.queuedAtMs,
                  acceptedAtMs: delivery.acceptedAtMs,
                  transportDown:
                    delivery.phase === "queued" &&
                    (AppState.currentState !== "active" ||
                      Date.now() < sendTransportDownUntilMsRef.current),
                  failure: delivery.failure,
                },
              },
            }
          : message
      ),
    };
  }, [durableSends, sendTransportRevision, snapshot]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    sidebarPreferencesRef.current = sidebarPreferences;
  }, [sidebarPreferences]);

  useEffect(() => {
    if (!sendController) {
      setDurableSends([]);
      setDeliveryRecoveries([]);
      return;
    }
    const publish = () => {
      setDurableSends(sendController.getSnapshot());
      setDeliveryRecoveries(sendController.getRecoverySnapshot());
    };
    publish();
    const unsubscribe = sendController.subscribe(publish);
    void sendController
      .restore()
      .then(() =>
        Promise.all(
          [...sendController.getSnapshot(), ...sendController.getRecoverySnapshot()].flatMap(
            (record) =>
              record.payload.consumedDraft
                ? [
                    clearConversationDraftIfCurrent(
                      record.payload.consumedDraft.key,
                      record.payload.consumedDraft.id
                    ),
                  ]
                : []
          )
        )
      )
      .catch(() => undefined);
    const interval = setInterval(() => {
      setSendTransportRevision((revision) => revision + 1);
      void sendController.expireAcknowledgements();
      if (AppState.currentState === "active") void sendController.flush();
    }, 5_000);
    const appState = AppState.addEventListener("change", (state) => {
      setSendTransportRevision((revision) => revision + 1);
      if (state === "active") void sendController.flush();
    });
    return () => {
      clearInterval(interval);
      appState.remove();
      unsubscribe();
      sendController.dispose();
    };
  }, [sendController]);

  useEffect(() => {
    if (!sendController) return;
    void sendController.reconcile(snapshot.channelMessages);
  }, [sendController, snapshot.channelMessages]);

  useEffect(() => {
    let active = true;
    void loadServerConnection()
      .then((loaded) => {
        if (!active) return;
        configureAuthServer(loaded.serverUrl);
        setConnection(loaded);
        setConnectionLoaded(true);
      })
      .catch((cause) => {
        if (!active) return;
        setConnectionLoaded(true);
        setLoading(false);
        setError(clientErrorMessage(cause, "Could not load server settings"));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!connectionLoaded) return;
    setReadyClient(null);
    const epoch = connectionEpochRef.current + 1;
    connectionEpochRef.current = epoch;
    connectionUrlRef.current = connection.serverUrl;
    remoteAcceptedEpochRef.current = -1;
    eventCursorRef.current.reset();
    activeHistoryChannelId.current = null;
    inactiveHistoryLru.current = [];
    hydrationRequests.current.clear();
    historyStore.current.clear();
    readReceipts.current.clear();
    lastBadgeCountRef.current = null;
    if (syncRetryTimerRef.current) clearTimeout(syncRetryTimerRef.current);
    syncRetryTimerRef.current = null;
    syncRetryAttemptRef.current = 0;
    syncRequestRef.current = null;
    syncRequestedRef.current = false;
    setSyncReadyEpoch(null);
    setHistoryState({});
    setDurableSends([]);
    setCapabilities(CLIENT_CAPABILITIES);
    setHiddenBots([]);
    setSidebarPreferences(emptySidebarPreferences());
    setRefreshing(false);
    const initial = connection.serverUrl ? emptyRemoteSnapshot() : mobileFixture;
    snapshotRef.current = initial;
    setSnapshot(initial);
    setLoading(Boolean(connection.serverUrl));
    setReadyClient(candidateClient);
    if (!connection.serverUrl) return;

    let active = true;
    void loadCachedSnapshot(connection.serverUrl)
      .then((cached) => {
        if (
          !active ||
          !cached ||
          epoch !== connectionEpochRef.current ||
          remoteAcceptedEpochRef.current === epoch
        ) {
          return;
        }
        const counts = new Map<string, number>();
        for (const message of cached.channelMessages) {
          counts.set(message.channelId, (counts.get(message.channelId) ?? 0) + 1);
        }
        inactiveHistoryLru.current = [...counts]
          .filter(([, count]) => count > 1)
          .map(([channelId]) => channelId)
          .slice(0, 3);
        eventCursorRef.current.reset(cached.cursor);
        acceptRemoteSnapshot(cached, epoch, false);
        setSyncReadyEpoch(epoch);
        setLoading(false);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [acceptRemoteSnapshot, candidateClient, connection.serverUrl, connectionLoaded]);

  const refresh = useCallback(async () => {
    if (!client) return;
    const operationClient = client;
    const epoch = connectionEpochRef.current;
    setRefreshing(true);
    try {
      const [bootstrap, rootSettings, allBots] = await Promise.all([
        operationClient.bootstrap(),
        operationClient.rootSettings().catch(() => null),
        operationClient.bots(true).catch(() => null),
      ]);
      if (!operationIsCurrent(operationClient, epoch)) return;
      if (!acceptRemoteBootstrap(bootstrap, epoch)) {
        throw new Error("OpenTeam returned a bootstrap older than an observed event");
      }
      if (allBots) setHiddenBots(allBots.filter((bot) => bot.hiddenFromSidebar));
      if (rootSettings) {
        const adapted = sidebarPreferencesFromRootSettings(
          rootSettings,
          sidebarPreferencesRef.current
        );
        if (adapted) setSidebarPreferences(adapted);
      }
      setError(null);
    } catch (cause) {
      if (operationIsCurrent(operationClient, epoch)) {
        setError(clientErrorMessage(cause, "Could not reach OpenTeam"));
      }
    } finally {
      if (operationIsCurrent(operationClient, epoch)) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [acceptRemoteBootstrap, client, operationIsCurrent]);

  useEffect(() => {
    const liveNonces = new Set(durableSends.map((record) => record.nonce));
    for (const nonce of acceptedSendRefreshesRef.current) {
      if (!liveNonces.has(nonce)) acceptedSendRefreshesRef.current.delete(nonce);
    }
    const hasNewAcceptance = durableSends.some((record) => {
      if (
        record.phase !== "accepted-awaiting-echo" ||
        acceptedSendRefreshesRef.current.has(record.nonce)
      ) {
        return false;
      }
      acceptedSendRefreshesRef.current.add(record.nonce);
      return true;
    });
    if (hasNewAcceptance) void refresh();
  }, [durableSends, refresh]);

  const scheduleSyncRetry = useCallback(
    (operationClient: MobileClient, epoch: number, delay: number) => {
      if (!operationIsCurrent(operationClient, epoch) || syncRetryTimerRef.current) return;
      syncRetryTimerRef.current = setTimeout(() => {
        syncRetryTimerRef.current = null;
        if (operationIsCurrent(operationClient, epoch)) void syncRemoteCallbackRef.current?.();
      }, delay);
    },
    [operationIsCurrent]
  );

  const deferHistorySync = useCallback(
    (operationClient: MobileClient, epoch: number, pending?: Promise<unknown>) => {
      const retry = () => scheduleSyncRetry(operationClient, epoch, LIVE_SYNC_DEBOUNCE_MS);
      if (!pending) {
        retry();
        return;
      }
      if (deferredHistorySyncs.current.has(pending)) return;
      deferredHistorySyncs.current.add(pending);
      void pending.then(retry, retry);
    },
    [scheduleSyncRetry]
  );

  const syncRequestRef = useRef<Promise<void> | null>(null);
  const syncRequestedRef = useRef(false);
  const syncRemote = useCallback(async () => {
    if (!client || AppState.currentState !== "active") return;
    if (syncRequestRef.current) {
      syncRequestedRef.current = true;
      await syncRequestRef.current;
      return;
    }
    const operationClient = client;
    const epoch = connectionEpochRef.current;
    const request = (async () => {
      do {
        syncRequestedRef.current = false;
        const outcome = await synchronizeClientSnapshot({
          readBootstrap: () => operationClient.bootstrap(),
          readHistory: (channelId) =>
            operationClient.channelHistory(channelId, { limit: MESSAGE_HISTORY_PAGE_SIZE }),
          readState: (channelId) => operationClient.channelState(channelId),
          activeChannel: () => activeHistoryChannelId.current,
          historyIdentity: (channelId) => historyStore.current.get(channelId),
          pendingHistory: (channelId) => hydrationRequests.current.pending(channelId),
          isCurrent: () => operationIsCurrent(operationClient, epoch),
          acceptBootstrap: (bootstrap) => acceptRemoteBootstrap(bootstrap, epoch),
          acceptHistory: (page) => {
            historyStore.current.acceptPage(page, "refresh");
            publishHistory(page.channelId, epoch);
          },
          acceptState: (state) => {
            acceptChannelState(state, epoch);
          },
          defer: (pending) => deferHistorySync(operationClient, epoch, pending),
        });
        if (outcome === "stale") return;
        if (outcome === "deferred") continue;
        setError(null);
        setLoading(false);
        syncRetryAttemptRef.current = 0;
        if (syncRetryTimerRef.current) clearTimeout(syncRetryTimerRef.current);
        syncRetryTimerRef.current = null;
      } while (syncRequestedRef.current && operationIsCurrent(operationClient, epoch));
    })()
      .catch((cause) => {
        if (operationIsCurrent(operationClient, epoch)) {
          setError(clientErrorMessage(cause, "Could not reach OpenTeam"));
          const delay = reconnectDelay(syncRetryAttemptRef.current);
          syncRetryAttemptRef.current += 1;
          scheduleSyncRetry(operationClient, epoch, delay);
        }
      })
      .finally(() => {
        if (syncRequestRef.current === request) {
          syncRequestRef.current = null;
          // A continuation can request a refresh after the loop's final check.
          // Preserve that last update instead of waiting for a fallback poll.
          if (syncRequestedRef.current) scheduleSyncRetry(operationClient, epoch, 0);
        }
      });
    syncRequestRef.current = request;
    await request;
  }, [
    publishHistory,
    acceptChannelState,
    acceptRemoteBootstrap,
    client,
    operationIsCurrent,
    deferHistorySync,
    scheduleSyncRetry,
  ]);
  syncRemoteCallbackRef.current = syncRemote;

  useEffect(() => {
    if (!connectionLoaded || !client) return;
    const count = snapshot.channels.reduce(
      (total, channel) => total + Math.max(0, Math.floor(channel.unreadCount ?? 0)),
      0
    );
    if (lastBadgeCountRef.current === count) return;
    lastBadgeCountRef.current = count;
    void setNotificationBadge(count).catch(() => {
      if (lastBadgeCountRef.current === count) lastBadgeCountRef.current = null;
    });
  }, [client, connectionLoaded, snapshot.channels]);

  useEffect(() => {
    if (connectionLoaded) void refresh();
  }, [connectionLoaded, refresh]);

  useEffect(() => {
    if (!client || syncReadyEpoch === connectionEpochRef.current) return;
    const epoch = connectionEpochRef.current;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const retryInitialSync = async () => {
      if (!stopped && AppState.currentState === "active") await refresh();
      if (
        stopped ||
        epoch !== connectionEpochRef.current ||
        remoteAcceptedEpochRef.current === epoch
      ) {
        return;
      }
      timer = setTimeout(() => void retryInitialSync(), reconnectDelay(attempt));
      attempt += 1;
    };
    timer = setTimeout(() => void retryInitialSync(), reconnectDelay(attempt));
    attempt += 1;
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, refresh, syncReadyEpoch]);

  useEffect(() => {
    if (!client || syncReadyEpoch !== connectionEpochRef.current) return;
    const epoch = connectionEpochRef.current;
    const liveSync = createLiveSyncController({
      cursor: () => eventCursorRef.current.reconnectAfter(),
      listen: (after, handlers, signal) => client.listenForEvents(after, handlers, signal),
      synchronize: syncRemote,
      isCurrent: () => operationIsCurrent(client, epoch),
      handleEvent: (productEvent) => {
        if (productEvent.topic === "snapshot.required") {
          const reason =
            productEvent.payload &&
            typeof productEvent.payload === "object" &&
            !Array.isArray(productEvent.payload)
              ? (productEvent.payload as { reason?: unknown }).reason
              : null;
          if (reason === "cursor_ahead") {
            eventCursorRef.current.requireSnapshot(productEvent.sequence);
          } else {
            eventCursorRef.current.observe(productEvent.sequence);
          }
        } else {
          eventCursorRef.current.observe(productEvent.sequence);
        }
        return shouldRefreshForEvent(productEvent);
      },
      onHealthChange: (healthy) => {
        if (healthy) void sendController?.flush();
      },
    });

    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        liveSync.setActive(true, true);
        return;
      }
      liveSync.setActive(false);
      void flushCachedSnapshotWrites().catch(() => undefined);
    });
    liveSync.setActive(AppState.currentState === "active");
    return () => {
      liveSync.stop();
      appStateSubscription.remove();
    };
  }, [client, operationIsCurrent, sendController, syncReadyEpoch, syncRemote]);

  useEffect(() => {
    if (!client || syncReadyEpoch !== connectionEpochRef.current) return;
    const epoch = connectionEpochRef.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pollRuntime = async () => {
      if (!stopped && AppState.currentState === "active") {
        try {
          const view = await client.runtime();
          if (operationIsCurrent(client, epoch) && !stopped) {
            const current = snapshotRef.current;
            if (JSON.stringify(current.runtime) !== JSON.stringify(view.runtime)) {
              acceptRemoteSnapshot({ ...current, runtime: view.runtime }, epoch);
            }
          }
        } catch {
          // Bootstrap/event reconciliation remains authoritative if this lightweight poll fails.
        }
      }
      if (!stopped) timer = setTimeout(() => void pollRuntime(), RUNTIME_REFRESH_MS);
    };
    timer = setTimeout(() => void pollRuntime(), RUNTIME_REFRESH_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [acceptRemoteSnapshot, client, operationIsCurrent, syncReadyEpoch]);

  useEffect(() => {
    if (!client) return;
    return onBeforeSignOut(() => {
      beginClientRetirement(client);
      return retirePushClient(client);
    });
  }, [beginClientRetirement, client, retirePushClient]);

  useEffect(() => {
    let active = true;
    const sync = async () => {
      try {
        const operation = client
          ? synchronizePushRegistration(client, false, () => pushOperationIsCurrent(client))
          : notificationPermissionState();
        if (client) trackPushOperation(client, operation);
        const permission = await operation;
        if (active && (!client || pushOperationIsCurrent(client))) {
          setNotificationPermission(permission);
          setNotificationError(null);
        }
      } catch (cause) {
        if (active && (!client || pushOperationIsCurrent(client))) {
          const permission = await notificationPermissionState().catch(
            (): NotificationPermissionState => "unavailable"
          );
          if (!active || (client && !pushOperationIsCurrent(client))) return;
          setNotificationPermission(permission);
          setNotificationError(clientErrorMessage(cause, "Could not register for notifications"));
        }
      }
    };
    void sync();
    const tokenSubscription = client
      ? listenForPushTokenChanges(
          client,
          (cause) => {
            if (active && pushOperationIsCurrent(client)) {
              setNotificationError(clientErrorMessage(cause, "Could not refresh the push token"));
            }
          },
          () => pushOperationIsCurrent(client),
          (operation) => trackPushOperation(client, operation)
        )
      : null;
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void sync();
    });
    return () => {
      active = false;
      if (activeClientRef.current === client) activeClientRef.current = null;
      tokenSubscription?.remove();
      appStateSubscription.remove();
    };
  }, [client, pushOperationIsCurrent, trackPushOperation]);

  const saveConnection = useCallback(
    async (input: ServerConnectionConfig) => {
      const normalized = normalizeServerConnection(input);
      const saved = await saveServerConnection(normalized);
      if (client && saved.serverUrl !== connection.serverUrl) {
        beginClientRetirement(client);
        await retirePushClient(client);
      }
      configureAuthServer(saved.serverUrl);
      setLoading(Boolean(saved.serverUrl));
      setError(null);
      setConnection(saved);
    },
    [beginClientRetirement, client, connection.serverUrl, retirePushClient]
  );

  const hydrateChannel = useCallback(
    async (channelId: string, targetMessageId?: string) => {
      if (!client) return;
      activeHistoryChannelId.current = channelId;
      inactiveHistoryLru.current = inactiveHistoryLru.current.filter(
        (candidate) => candidate !== channelId
      );
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      hydrationRequests.current.invalidate(channelId);
      await hydrationRequests.current.run(channelId, async (lease) => {
        const current = () =>
          operationIsCurrent(operationClient, epoch) &&
          hydrationRequests.current.isCurrent(lease) &&
          activeHistoryChannelId.current === channelId;
        setHistoryState((state) => ({
          ...state,
          [channelId]: {
            beforeSequence: state[channelId]?.beforeSequence ?? null,
            hasMore: state[channelId]?.hasMore ?? false,
            loading: true,
          },
        }));
        try {
          const [page, targetContext, channelState] = await Promise.all([
            operationClient.channelHistory(channelId, { limit: MESSAGE_HISTORY_PAGE_SIZE }),
            targetMessageId
              ? operationClient
                  .messageContext(targetMessageId, { before: 40, after: 40 })
                  .catch(() => null)
              : Promise.resolve(null),
            operationClient.channelState(channelId),
          ]);
          if (!current()) return;
          historyStore.current.acceptPage(page, "replace");
          if (targetContext?.channelId === channelId)
            historyStore.current.acceptContext(targetContext);
          publishHistory(channelId, epoch);
          acceptChannelState(channelState, epoch);
          setError(null);
        } catch (cause) {
          if (!current()) return;
          setHistoryState((state) => ({
            ...state,
            [channelId]: {
              beforeSequence: state[channelId]?.beforeSequence ?? null,
              hasMore: state[channelId]?.hasMore ?? false,
              loading: false,
            },
          }));
          setError(clientErrorMessage(cause, "Could not load this conversation"));
        }
      });
    },
    [acceptChannelState, client, operationIsCurrent, publishHistory]
  );

  const releaseChannel = useCallback(
    (channelId: string) => {
      if (activeHistoryChannelId.current !== channelId) return;
      activeHistoryChannelId.current = null;
      hydrationRequests.current.invalidate(channelId);
      historyStore.current.delete(channelId);
      inactiveHistoryLru.current = touchHistoryLru(inactiveHistoryLru.current, channelId);
      const retained = retainedHistoryIds(null, inactiveHistoryLru.current);
      acceptRemoteSnapshot(
        trimInactiveHistories(snapshotRef.current, null, inactiveHistoryLru.current)
      );
      setHistoryState((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => retained.has(id)))
      );
    },
    [acceptRemoteSnapshot]
  );

  const loadHistoryPage = useCallback(
    async (channelId: string, direction: "older" | "newer") => {
      if (!client || activeHistoryChannelId.current !== channelId) return;
      const entry = historyStore.current.get(channelId);
      const status = historyStore.current.status(channelId);
      if (!entry || !status || !(direction === "older" ? status.hasMore : status.hasNewer)) return;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await hydrationRequests.current.run(channelId, async (lease) => {
        const current = () =>
          operationIsCurrent(operationClient, epoch) &&
          hydrationRequests.current.isCurrent(lease) &&
          activeHistoryChannelId.current === channelId;
        if (direction === "older")
          setHistoryState((state) => ({ ...state, [channelId]: { ...status, loading: true } }));
        try {
          if (entry.window.context || direction === "newer") {
            const messages = entry.window.context
              ? entry.history.searchContext
              : entry.history.messages;
            const edge = direction === "older" ? messages[0] : messages.at(-1);
            if (!edge) return;
            const page = await operationClient.messageContext(edge.id, {
              direction: direction === "older" ? "before" : "after",
              limit: MESSAGE_HISTORY_PAGE_SIZE,
            });
            if (!current() || page.channelId !== channelId) return;
            historyStore.current.expand(page, direction);
          } else {
            const page = await operationClient.channelHistory(channelId, {
              beforeSequence: status.beforeSequence ?? undefined,
              limit: MESSAGE_HISTORY_PAGE_SIZE,
            });
            if (!current()) return;
            historyStore.current.acceptPage(page, "older");
          }
          publishHistory(channelId, epoch);
        } catch (cause) {
          if (!current()) return;
          setError(
            clientErrorMessage(
              cause,
              direction === "older"
                ? "Could not load earlier messages"
                : "Could not load later messages"
            )
          );
        } finally {
          if (current() && direction === "older")
            setHistoryState((state) => {
              const previous = state[channelId];
              return previous ? { ...state, [channelId]: { ...previous, loading: false } } : state;
            });
        }
      });
    },
    [client, operationIsCurrent, publishHistory]
  );
  const loadEarlierMessages = useCallback(
    (channelId: string) => loadHistoryPage(channelId, "older"),
    [loadHistoryPage]
  );
  const loadLaterMessages = useCallback(
    (channelId: string) => loadHistoryPage(channelId, "newer"),
    [loadHistoryPage]
  );
  const jumpToLatestMessages = useCallback(
    async (channelId: string) => {
      hydrationRequests.current.invalidate(channelId);
      historyStore.current.setViewport(channelId, [], true);
      if (historyStore.current.jumpToLatest(channelId)) publishHistory(channelId);
      await hydrateChannel(channelId);
    },
    [hydrateChannel, publishHistory]
  );

  const markChannelRead = useCallback(
    async (channelId: string, throughSequence?: string) => {
      const current = snapshotRef.current;
      const channel = current.channels.find((candidate) => candidate.id === channelId);
      const latestValue = latestNumericSequence(current.channelMessages, channelId);
      if (!latestValue) return;
      const target = readReceiptTarget(latestValue, throughSequence);
      if (target === null) return;
      if ((channel?.unreadCount ?? 0) <= 0 && !readReceipts.current.hasState(channelId)) return;
      const acknowledged = readReceipts.current.acknowledgedThrough(channelId);
      if (acknowledged !== null && BigInt(target) <= BigInt(acknowledged)) return;
      if (BigInt(target) >= BigInt(latestValue)) {
        acceptRemoteSnapshot({
          ...current,
          channels: current.channels.map((candidate) =>
            candidate.id === channelId ? { ...candidate, unreadCount: 0 } : candidate
          ),
        });
      }
      if (!client) return;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await readReceipts.current.request(channelId, target, {
        send: (id, sequence) => operationClient.markChannelRead(id, sequence),
        isCurrent: () => operationIsCurrent(operationClient, epoch),
        onAcknowledged: (result) => {
          const next = snapshotRef.current;
          acceptRemoteSnapshot(
            {
              ...next,
              channels: next.channels.map((candidate) =>
                candidate.id === channelId
                  ? { ...candidate, unreadCount: result.unreadCount }
                  : candidate
              ),
            },
            epoch
          );
        },
        onError: (cause) => setError(clientErrorMessage(cause, "Could not update read state")),
      });
    },
    [acceptRemoteSnapshot, client, operationIsCurrent]
  );

  const enableNotifications = useCallback(async () => {
    setNotificationError(null);
    if (!client) {
      setNotificationError("Connect OpenTeam to a server before enabling push notifications.");
      return;
    }
    const operationClient = client;
    try {
      const operation = synchronizePushRegistration(operationClient, true, () =>
        pushOperationIsCurrent(operationClient)
      );
      trackPushOperation(operationClient, operation);
      const permission = await operation;
      if (!pushOperationIsCurrent(operationClient)) return;
      setNotificationPermission(permission);
    } catch (cause) {
      if (!pushOperationIsCurrent(operationClient)) return;
      setNotificationError(clientErrorMessage(cause, "Could not enable push notifications"));
      const permission = await notificationPermissionState().catch(
        (): NotificationPermissionState => "unavailable"
      );
      if (pushOperationIsCurrent(operationClient)) setNotificationPermission(permission);
    }
  }, [client, pushOperationIsCurrent, trackPushOperation]);

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
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      try {
        await operationClient.updateBot(botId, { notificationsEnabled: enabled });
        if (operationIsCurrent(operationClient, epoch)) await refresh();
      } catch (cause) {
        if (!operationIsCurrent(operationClient, epoch)) return;
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
    [client, operationIsCurrent, refresh, snapshot.bots]
  );

  const createBot = useCallback(
    async (name: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before creating a Bot.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const bot = await operationClient.createBot({
        clientRequestId: mutationId(),
        name: name.trim(),
      });
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while creating this Bot.");
      }
      const bootstrap = await operationClient.bootstrap();
      if (!operationIsCurrent(operationClient, epoch) || !acceptRemoteBootstrap(bootstrap, epoch)) {
        throw new Error("The OpenTeam server changed while creating this Bot.");
      }
      return bot.dmChannelId;
    },
    [acceptRemoteBootstrap, client, operationIsCurrent]
  );

  const createGroup = useCallback(
    async (name: string, botIds: string[]) => {
      if (!client) throw new Error("Connect OpenTeam to a server before creating a group.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const channel = await operationClient.createGroup({ name: name.trim(), botIds });
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while creating this group.");
      }
      const bootstrap = await operationClient.bootstrap();
      if (!operationIsCurrent(operationClient, epoch) || !acceptRemoteBootstrap(bootstrap, epoch)) {
        throw new Error("The OpenTeam server changed while creating this group.");
      }
      return channel.id;
    },
    [acceptRemoteBootstrap, client, operationIsCurrent]
  );

  const duplicateBot = useCallback(
    async (botId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before duplicating a Bot.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const source = snapshotRef.current.bots.find((bot) => bot.id === botId);
      if (!source) throw new Error("Bot not found.");
      const duplicate = await operationClient.createBot({
        clientRequestId: mutationId(),
        name: `${source.name} Copy`,
        title: source.title,
        description: source.description,
        instructions: source.instructions,
        icon: source.icon,
        color: source.color,
        notificationsEnabled: source.notificationsEnabled,
      });
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while duplicating this Bot.");
      }
      const bootstrap = await operationClient.bootstrap();
      if (!operationIsCurrent(operationClient, epoch) || !acceptRemoteBootstrap(bootstrap, epoch)) {
        throw new Error("The OpenTeam server changed while duplicating this Bot.");
      }
      return duplicate.dmChannelId;
    },
    [acceptRemoteBootstrap, client, operationIsCurrent]
  );

  const archiveBot = useCallback(
    async (botId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before deleting a Bot.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.archiveBot(botId);
      if (!operationIsCurrent(operationClient, epoch)) return;
      const bootstrap = await operationClient.bootstrap();
      if (operationIsCurrent(operationClient, epoch)) acceptRemoteBootstrap(bootstrap, epoch);
    },
    [acceptRemoteBootstrap, client, operationIsCurrent]
  );

  const updateBot = useCallback(
    async (botId: string, input: UpdateBotInput) => {
      if (!client) throw new Error("Connect OpenTeam to a server before editing a Bot.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const updated = await operationClient.updateBot(botId, input);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while saving this Bot.");
      }
      setSnapshot((current) => ({
        ...current,
        bots: current.bots.map((bot) => (bot.id === botId ? updated : bot)),
      }));
      return updated;
    },
    [client, operationIsCurrent]
  );

  const togglePinned = useCallback(
    async (channelId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before changing pins.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const previous = sidebarPreferencesRef.current;
      const next = toggleSidebarPinned(previous, channelId);
      sidebarPreferencesRef.current = next;
      setSidebarPreferences(next);
      try {
        await operationClient.updateSidebarPreferences(next);
      } catch (cause) {
        if (!operationIsCurrent(operationClient, epoch)) return;
        sidebarPreferencesRef.current = previous;
        setSidebarPreferences(previous);
        throw cause;
      }
    },
    [client, operationIsCurrent]
  );

  const updateSidebarPreferences = useCallback(
    async (next: SidebarPreferences) => {
      if (!client) throw new Error("Connect OpenTeam to a server before changing the sidebar.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const previous = sidebarPreferencesRef.current;
      sidebarPreferencesRef.current = next;
      setSidebarPreferences(next);
      try {
        await operationClient.updateSidebarPreferences(next);
      } catch (cause) {
        if (!operationIsCurrent(operationClient, epoch)) return;
        sidebarPreferencesRef.current = previous;
        setSidebarPreferences(previous);
        throw cause;
      }
    },
    [client, operationIsCurrent]
  );

  const setBotHidden = useCallback(
    async (botId: string, hidden: boolean) => {
      if (!client) throw new Error("Connect OpenTeam to a server before hiding a conversation.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const previous = snapshotRef.current.bots.find((bot) => bot.id === botId);
      setSnapshot((current) => ({
        ...current,
        bots: current.bots.map((bot) =>
          bot.id === botId ? { ...bot, hiddenFromSidebar: hidden } : bot
        ),
      }));
      try {
        await operationClient.updateBot(botId, { hiddenFromSidebar: hidden });
        if (operationIsCurrent(operationClient, epoch)) await refresh();
      } catch (cause) {
        if (!operationIsCurrent(operationClient, epoch)) return;
        if (previous) {
          setSnapshot((current) => ({
            ...current,
            bots: current.bots.map((bot) => (bot.id === botId ? previous : bot)),
          }));
        }
        throw cause;
      }
    },
    [client, operationIsCurrent, refresh]
  );

  const setChannelHidden = useCallback(
    async (channelId: string, hidden: boolean) => {
      if (!client) throw new Error("Connect OpenTeam to a server before hiding a conversation.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const previous = snapshotRef.current.channels.find((channel) => channel.id === channelId);
      setSnapshot((current) => ({
        ...current,
        channels: current.channels.map((channel) =>
          channel.id === channelId ? { ...channel, hiddenFromSidebar: hidden } : channel
        ),
      }));
      try {
        await operationClient.setChannelHidden(channelId, hidden);
        if (operationIsCurrent(operationClient, epoch)) await refresh();
      } catch (cause) {
        if (!operationIsCurrent(operationClient, epoch)) return;
        if (previous) {
          setSnapshot((current) => ({
            ...current,
            channels: current.channels.map((channel) =>
              channel.id === channelId ? previous : channel
            ),
          }));
        }
        throw cause;
      }
    },
    [client, operationIsCurrent, refresh]
  );

  const deleteGroup = useCallback(
    async (channelId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before deleting a group.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.deleteGroup(channelId);
      if (!operationIsCurrent(operationClient, epoch)) return;
      const bootstrap = await operationClient.bootstrap();
      if (operationIsCurrent(operationClient, epoch)) acceptRemoteBootstrap(bootstrap, epoch);
    },
    [acceptRemoteBootstrap, client, operationIsCurrent]
  );

  const renameChannel = useCallback(
    async (channelId: string, name: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before editing a group.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const updated = await operationClient.renameChannel(channelId, name.trim());
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while renaming this group.");
      }
      setSnapshot((current) => ({
        ...current,
        channels: current.channels.map((channel) => (channel.id === channelId ? updated : channel)),
      }));
      return updated;
    },
    [client, operationIsCurrent]
  );

  const setChannelMembers = useCallback(
    async (channelId: string, botIds: string[]) => {
      if (!client) throw new Error("Connect OpenTeam to a server before editing a group.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const updated = await operationClient.setChannelMembers(channelId, botIds);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while updating this group.");
      }
      setSnapshot((current) => ({
        ...current,
        channels: current.channels.map((channel) => (channel.id === channelId ? updated : channel)),
      }));
      return updated;
    },
    [client, operationIsCurrent]
  );

  const updateChannelProfile = useCallback(
    async (channelId: string, name: string, description: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before editing a group.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const updated = await operationClient.updateChannelProfile(
        channelId,
        name.trim(),
        description.trim()
      );
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while updating this group.");
      }
      setSnapshot((current) => ({
        ...current,
        channels: current.channels.map((channel) => (channel.id === channelId ? updated : channel)),
      }));
      return updated;
    },
    [client, operationIsCurrent]
  );

  const routines = useCallback(
    async (ownerId: string, ownerKind: "bot" | "group" = "bot") => {
      if (!client) return [];
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.routines(ownerId, ownerKind);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while loading routines.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const routine = useCallback(
    async (routineId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before loading a routine.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.routine(routineId);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while loading this routine.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const createRoutine = useCallback(
    async (ownerId: string, ownerKind: "bot" | "group", input: CreateRoutineInput) => {
      if (!client) throw new Error("Connect OpenTeam to a server before creating a routine.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.createRoutine(ownerId, ownerKind, input);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while creating this routine.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const updateRoutine = useCallback(
    async (routineId: string, input: UpdateRoutineInput) => {
      if (!client) throw new Error("Connect OpenTeam to a server before updating a routine.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.updateRoutine(routineId, input);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while updating this routine.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const setRoutineEnabled = useCallback(
    async (routine: RoutineView, enabled: boolean) => {
      if (!client) throw new Error("Connect OpenTeam to a server before changing a routine.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.setRoutineEnabled(routine, enabled);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while updating this routine.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const deleteRoutine = useCallback(
    async (candidate: RoutineView) => {
      if (!client) throw new Error("Connect OpenTeam to a server before deleting a routine.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.deleteRoutine(candidate);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while deleting this routine.");
      }
    },
    [client, operationIsCurrent]
  );

  const runRoutineNow = useCallback(
    async (routineId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before running a routine.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.runRoutineNow(routineId);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while starting this routine.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const routineExecutions = useCallback(
    async (routineId: string, limit = 20) => {
      if (!client) return [];
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.routineExecutions(routineId, limit);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while loading routine history.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const pluginSettings = useCallback(async () => {
    if (!client) return { catalog: [], installs: [], botCount: 0, policies: [], activity: [] };
    const operationClient = client;
    const epoch = connectionEpochRef.current;
    const result = await operationClient.pluginSettings();
    if (!operationIsCurrent(operationClient, epoch)) {
      throw new Error("The OpenTeam server changed while loading plugins.");
    }
    return result;
  }, [client, operationIsCurrent]);

  const pluginBotAccess = useCallback(
    async (
      pluginKey: string,
      query: { query?: string; offset?: number; limit?: number; signal?: AbortSignal } = {}
    ) => {
      if (!client) {
        return {
          pluginKey,
          query: query.query ?? "",
          offset: query.offset ?? 0,
          total: 0,
          bots: [],
        };
      }
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.pluginBotAccess(pluginKey, query);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while loading plugin access.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const installPlugin = useCallback(
    async (pluginKey: string, values?: Record<string, string>) => {
      if (!client) throw new Error("Connect OpenTeam to a server before installing plugins.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.installPlugin(pluginKey, values);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while installing this plugin.");
      }
    },
    [client, operationIsCurrent]
  );

  const uninstallPlugin = useCallback(
    async (pluginKey: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before removing plugins.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.uninstallPlugin(pluginKey);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while removing this plugin.");
      }
    },
    [client, operationIsCurrent]
  );

  const setPluginEnablement = useCallback(
    async (pluginKey: string, botId: string, enabled: boolean, skillsEnabled = enabled) => {
      if (!client) throw new Error("Connect OpenTeam to a server before changing plugin access.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.setPluginEnablement(pluginKey, botId, enabled, skillsEnabled);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while changing plugin access.");
      }
    },
    [client, operationIsCurrent]
  );

  const setPluginGrant = useCallback(
    async (connectionId: string, botId: string, enabled: boolean) => {
      if (!client) throw new Error("Connect OpenTeam to a server before changing plugin access.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.setPluginGrant(connectionId, botId, enabled);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while changing plugin access.");
      }
    },
    [client, operationIsCurrent]
  );

  const connectPlugin = useCallback(
    async (connectionId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before connecting plugins.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.connectPlugin(connectionId);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while connecting this plugin.");
      }
    },
    [client, operationIsCurrent]
  );

  const disconnectPlugin = useCallback(
    async (connectionId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before disconnecting plugins.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.disconnectPlugin(connectionId);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while disconnecting this plugin.");
      }
    },
    [client, operationIsCurrent]
  );

  const authenticatePlugin = useCallback(
    async (connectionId: string) => {
      if (!client) throw new Error("Connect OpenTeam to a server before authorizing plugins.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.authenticatePlugin(connectionId, true);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while authorizing this plugin.");
      }
      return result.authorizationUrl;
    },
    [client, operationIsCurrent]
  );

  const search = useCallback(
    (query: string, category: SearchCategory = "all", signal?: AbortSignal) =>
      client
        ? client.search(query, category, signal)
        : Promise.resolve(searchClientSnapshot(snapshotRef.current, query, category)),
    [client]
  );

  const sendMessage = useCallback(
    async (
      channelId: string,
      content: string,
      attachments: readonly AssetRef[] = [],
      replyToMessageId?: string,
      options?: {
        isFork?: boolean;
        consumedDraft?: { key: string; id: string };
        stagedAttachments?: DurableSendPayload["stagedAttachments"];
      }
    ) => {
      if (!client || !sendController) {
        const localId = mutationId();
        acceptChannelMessages(channelId, [
          {
            id: localId,
            sequence: localId,
            channelId,
            sender: "user",
            senderBotId: null,
            sourceRunId: null,
            content,
            metadata: {
              ...(attachments.length ? { attachments: [...attachments] } : {}),
              ...(replyToMessageId ? { replyTo: replyToMessageId } : {}),
              ...(options?.isFork ? { branched: true } : {}),
            },
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }
      const currentSnapshot = snapshotRef.current;
      const channel = currentSnapshot.channels.find((candidate) => candidate.id === channelId);
      const botId = channel?.kind === "bot_dm" ? channel.members[0]?.botId : null;
      const conversationId = botId
        ? currentSnapshot.bots.find((candidate) => candidate.id === botId)?.conversationId
        : null;
      await sendController.enqueue({
        target: { channelId, conversationId: conversationId ?? null },
        payload: {
          content,
          attachments: [...attachments],
          ...(options?.stagedAttachments?.length
            ? { stagedAttachments: options.stagedAttachments }
            : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(options?.isFork ? { isFork: true } : {}),
          ...(options?.consumedDraft ? { consumedDraft: options.consumedDraft } : {}),
        },
      });
    },
    [acceptChannelMessages, client, sendController]
  );

  const resendFailedMessage = useCallback(
    async (nonce: string) => {
      await sendController?.resendFailed(nonce);
    },
    [sendController]
  );

  const deleteFailedMessage = useCallback(
    async (nonce: string) => {
      await sendController?.deleteFailed(nonce);
    },
    [sendController]
  );

  const cancelQueuedMessage = useCallback(
    (nonce: string) => sendController?.cancelQueued(nonce) ?? Promise.resolve(null),
    [sendController]
  );

  const acknowledgeDeliveryRecovery = useCallback(
    (nonce: string) => sendController?.acknowledgeRecovery(nonce) ?? Promise.resolve(),
    [sendController]
  );

  const reactToMessage = useCallback(
    async (messageId: string, emoji: string) => {
      const previous = snapshotRef.current.channelMessages.find(
        (message) => message.id === messageId
      );
      if (previous) historyStore.current.patch(toggleOwnReaction(previous, emoji));
      setSnapshot((current) => ({
        ...current,
        channelMessages: current.channelMessages.map((message) =>
          message.id === messageId ? toggleOwnReaction(message, emoji) : message
        ),
      }));
      if (!client) return;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      try {
        const result = await operationClient.reactToMessage(messageId, emoji);
        if (!operationIsCurrent(operationClient, epoch)) return;
        historyStore.current.patch(result.message);
        setSnapshot((current) => ({
          ...current,
          channelMessages: current.channelMessages.map((message) =>
            message.id === messageId ? result.message : message
          ),
        }));
      } catch (cause) {
        if (!operationIsCurrent(operationClient, epoch)) return;
        if (previous) {
          historyStore.current.patch(previous);
          setSnapshot((current) => ({
            ...current,
            channelMessages: current.channelMessages.map((message) =>
              message.id === messageId ? previous : message
            ),
          }));
        }
        throw cause;
      }
    },
    [client, operationIsCurrent]
  );

  const acceptRichMessageMutation = useCallback(
    (message: ChannelMessageView, operationClient: MobileClient, epoch: number): boolean => {
      if (!operationIsCurrent(operationClient, epoch)) return false;
      historyStore.current.patch(message);
      setSnapshot((current) => ({
        ...current,
        channelMessages: current.channelMessages.map((candidate) =>
          candidate.id === message.id ? message : candidate
        ),
      }));
      return true;
    },
    [operationIsCurrent]
  );

  const respondToWidget = useCallback(
    async (messageId: string, value: string) => {
      if (!client) return false;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.respondToWidget(messageId, value);
      return acceptRichMessageMutation(result.message, operationClient, epoch) && result.accepted;
    },
    [acceptRichMessageMutation, client]
  );

  const dismissWidget = useCallback(
    async (messageId: string) => {
      if (!client) return false;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.dismissWidget(messageId);
      return acceptRichMessageMutation(result.message, operationClient, epoch) && result.accepted;
    },
    [acceptRichMessageMutation, client]
  );

  const submitSecret = useCallback(
    async (messageId: string, value: string) => {
      if (!client) return false;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.submitSecret(messageId, value);
      return acceptRichMessageMutation(result.message, operationClient, epoch) && result.accepted;
    },
    [acceptRichMessageMutation, client]
  );

  const mutateComputerHandoff = useCallback(
    async (messageId: string, action: "start" | "complete" | "skip" | "dismiss") => {
      if (!client) return false;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.mutateComputerHandoff(messageId, action);
      return acceptRichMessageMutation(result.message, operationClient, epoch) && result.accepted;
    },
    [acceptRichMessageMutation, client]
  );

  const uploadAsset = useCallback(
    async (input: {
      uri: string;
      fileName: string;
      mimeType?: string;
      alt?: string;
      signal?: AbortSignal;
      onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void;
    }) => {
      if (!client) throw new Error("Connect OpenTeam before uploading files.");
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const uploadToken = getAuthTokenForServer(operationClient.baseUrl);
      const asset = await uploadNativeAsset({
        serverUrl: operationClient.baseUrl,
        file: new File(input.uri),
        fileName: input.fileName,
        mimeType: input.mimeType,
        alt: input.alt,
        authToken: uploadToken,
        signal: input.signal,
        onProgress: input.onProgress,
        onUnauthorized: () => requireAuthenticationForServer(operationClient.baseUrl, uploadToken),
      });
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while uploading this file.");
      }
      return asset;
    },
    [client, operationIsCurrent]
  );

  const assetUrl = useCallback(
    (asset: Pick<AssetRef, "assetId" | "fileName">, download = false) =>
      client?.assetUrl(asset, download) ?? null,
    [client]
  );

  const resolveApproval = useCallback(
    async (approvalId: string, decision: "accept" | "decline") => {
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      if (operationClient) {
        await operationClient.resolveApproval(approvalId, decision);
        if (!operationIsCurrent(operationClient, epoch)) return;
      }
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId
            ? { ...approval, status: decision === "accept" ? "accepted" : "declined" }
            : approval
        ),
      }));
      if (operationClient && operationIsCurrent(operationClient, epoch)) await refresh();
    },
    [client, operationIsCurrent, refresh]
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      if (!client) return;
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      await operationClient.cancelRun(runId);
      if (!operationIsCurrent(operationClient, epoch)) return;
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.id === runId
            ? { ...run, status: "cancelled", finishedAt: new Date().toISOString() }
            : run
        ),
      }));
    },
    [client, operationIsCurrent]
  );

  const screenStatus = useCallback(
    async (botId: string) => {
      if (!client) {
        return fixtureScreenStatus(botId, fixtureTakeovers.current.get(botId) ?? false);
      }
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.screenStatus(botId);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while loading the computer.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const screenAction = useCallback(
    async (botId: string, input: ScreenActionInput) => {
      if (!client) {
        return fixtureScreenStatus(botId, fixtureTakeovers.current.get(botId) ?? false);
      }
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.screenAction(botId, input);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while sending computer input.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const setScreenTakeover = useCallback(
    async (botId: string, active: boolean) => {
      if (!client) {
        fixtureTakeovers.current.set(botId, active);
        return fixtureScreenStatus(botId, active);
      }
      const operationClient = client;
      const epoch = connectionEpochRef.current;
      const result = await operationClient.setScreenTakeover(botId, active);
      if (!operationIsCurrent(operationClient, epoch)) {
        throw new Error("The OpenTeam server changed while updating computer control.");
      }
      return result;
    },
    [client, operationIsCurrent]
  );

  const screenFrameUrl = useCallback(
    (botId: string, revision = Date.now()) =>
      client ? client.screenFrameUrl(botId, revision) : null,
    [client]
  );

  const rows = useMemo(() => selectChannelRows(visibleSnapshot), [visibleSnapshot]);

  const value = useMemo<OpenTeamState>(
    () => ({
      snapshot: visibleSnapshot,
      capabilities,
      hiddenBots,
      rows,
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
      createBot,
      duplicateBot,
      archiveBot,
      createGroup,
      updateBot,
      sidebarPreferences,
      updateSidebarPreferences,
      togglePinned,
      setBotHidden,
      setChannelHidden,
      deleteGroup,
      renameChannel,
      updateChannelProfile,
      setChannelMembers,
      routines,
      routine,
      createRoutine,
      updateRoutine,
      setRoutineEnabled,
      deleteRoutine,
      runRoutineNow,
      routineExecutions,
      pluginSettings,
      pluginBotAccess,
      installPlugin,
      uninstallPlugin,
      setPluginEnablement,
      setPluginGrant,
      connectPlugin,
      disconnectPlugin,
      authenticatePlugin,
      markChannelRead,
      refresh,
      hydrateChannel,
      releaseChannel,
      loadEarlierMessages,
      loadLaterMessages,
      jumpToLatestMessages,
      setHistoryViewport,
      visibleHistoryMessageIds,
      historyState,
      search,
      sendMessage,
      resendFailedMessage,
      deleteFailedMessage,
      cancelQueuedMessage,
      deliveryRecoveries,
      acknowledgeDeliveryRecovery,
      uploadAsset,
      assetUrl,
      reactToMessage,
      respondToWidget,
      dismissWidget,
      submitSecret,
      mutateComputerHandoff,
      resolveApproval,
      cancelRun,
      screenStatus,
      screenAction,
      setScreenTakeover,
      screenFrameUrl,
    }),
    [
      capabilities,
      error,
      connection,
      connectionLoaded,
      archiveBot,
      createBot,
      createGroup,
      duplicateBot,
      enableNotifications,
      assetUrl,
      hiddenBots,
      historyState,
      hydrateChannel,
      releaseChannel,
      loading,
      loadEarlierMessages,
      loadLaterMessages,
      jumpToLatestMessages,
      setHistoryViewport,
      visibleHistoryMessageIds,
      markChannelRead,
      notificationError,
      notificationPermission,
      openNotificationSettings,
      reactToMessage,
      respondToWidget,
      dismissWidget,
      submitSecret,
      mutateComputerHandoff,
      renameChannel,
      refresh,
      refreshing,
      resolveApproval,
      cancelRun,
      routine,
      routines,
      createRoutine,
      updateRoutine,
      deleteRoutine,
      runRoutineNow,
      routineExecutions,
      pluginSettings,
      pluginBotAccess,
      installPlugin,
      uninstallPlugin,
      setPluginEnablement,
      setPluginGrant,
      connectPlugin,
      disconnectPlugin,
      authenticatePlugin,
      search,
      saveConnection,
      screenAction,
      screenFrameUrl,
      screenStatus,
      setBotHidden,
      setChannelHidden,
      setBotNotifications,
      setChannelMembers,
      setRoutineEnabled,
      sidebarPreferences,
      updateSidebarPreferences,
      togglePinned,
      updateBot,
      updateChannelProfile,
      sendMessage,
      resendFailedMessage,
      deleteFailedMessage,
      cancelQueuedMessage,
      deliveryRecoveries,
      acknowledgeDeliveryRecovery,
      uploadAsset,
      setScreenTakeover,
      visibleSnapshot,
      rows,
      client,
      deleteGroup,
    ]
  );

  return <OpenTeamContext.Provider value={value}>{children}</OpenTeamContext.Provider>;
}

export const useOpenTeam = (): OpenTeamState => {
  const value = useContext(OpenTeamContext);
  if (!value) throw new Error("useOpenTeam must be used inside OpenTeamProvider");
  return value;
};
