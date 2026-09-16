import { crossesUnreadBoundary, unreadChatMessageCount } from "../../src/chat-unread-boundary";
import { useChatUnreadBoundary } from "../../src/hooks/use-chat-unread-boundary";
import { ConversationMessageFrame } from "../../src/components/conversation-message-frame";
import * as Haptics from "../../src/haptics";
import { useChatKeyboard } from "../../src/hooks/use-chat-keyboard";
import { ChatChromeFade } from "../../src/components/chat-chrome-fade";
import { useMessageFocus } from "../../src/hooks/use-message-focus";
import { useChatScroll } from "../../src/hooks/use-chat-scroll";
import { usePluginMentions } from "../../src/hooks/use-plugin-mentions";
import type { BotView, ChannelMessageView } from "@openteam/contracts";
import { addSidebarUnread } from "@openteam/contracts/client-preferences";
import { mentionHandleFor } from "@openteam/product-core/mentions";
import {
  type A2AActivityEntry,
  a2aProjectionFor,
  clientDeliveryFor,
  collapseA2ATimeline,
  deriveThreads,
  mayHaveEarlierThreadReplies,
  messageMetadata,
  messageRenderKey,
  selectA2AExchangeMessages,
} from "@openteam/product-core/messages";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { isActiveRunStatus } from "@openteam/product-core/statuses";
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getAuthAccountIdForServer, getAuthTokenForServer } from "../../src/auth";
import {
  enteringAppendedMessageKeys,
  highestVisibleSequence,
  isNearLiveEdge,
  laterSequence,
} from "../../src/chat-viewport";
import { A2AExchangeSheet, type MobileA2AExchange } from "../../src/components/a2a-exchange-sheet";
import { ApprovalCard } from "../../src/components/approval-card";
import { BotAvatar } from "../../src/components/bot-avatar";
import { Composer, type ComposerRecovery, type ReplyTarget } from "../../src/components/composer";
import { GlassSurface } from "../../src/components/glass-surface";
import { IconButton } from "../../src/components/icon-button";
import { NativeGlassButton } from "../../src/components/native-controls";
import { MessageBubble } from "../../src/components/message-bubble";
import { ThreadSheet } from "../../src/components/thread-sheet";
import { WorkingIndicator } from "../../src/components/working-indicator";
import { conversationDraftKey } from "../../src/drafts";
import {
  discardMobileDeliveryAttachments,
  stageMobileDeliveryAttachment,
} from "../../src/durable-attachment-stage";
import { MOBILE_VIRTUAL_LIST_TUNING } from "../../src/list-scale";
import { setActiveNotificationChannel } from "../../src/notifications";
import { routineRoute } from "../../src/routine-route";
import { useOpenTeam } from "../../src/state/openteam-context";
import { chatGlassTint, useChatTheme } from "../../src/chat-appearance";

const metadataFor = messageMetadata;
type ConversationTimelineEntry = ChannelMessageView | A2AActivityEntry<ChannelMessageView>;

const isA2AActivity = (
  entry: ConversationTimelineEntry
): entry is A2AActivityEntry<ChannelMessageView> => "type" in entry && entry.type === "a2a";

function A2AActivityRow({
  count,
  onOpen,
  peer,
  peerName,
}: {
  count: number;
  onOpen?: () => void;
  peer?: BotView;
  peerName: string;
}) {
  const theme = useChatTheme();
  const name = peer?.name ?? peerName;
  return (
    <Pressable
      accessible
      accessibilityLabel={
        onOpen
          ? `Open A2A exchange with ${name}, ${count} ${count === 1 ? "message" : "messages"}`
          : `${count} ${count === 1 ? "message" : "messages"} with ${name}`
      }
      accessibilityRole={onOpen ? "button" : "text"}
      disabled={!onOpen}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.a2aActivity,
        { backgroundColor: pressed ? theme.surfacePressed : "transparent" },
      ]}
    >
      <SymbolView name="arrow.left.arrow.right" size={13} tintColor={theme.textMuted} />
      <Text style={[styles.a2aActivityText, { color: theme.textMuted }]}>
        {count} {count === 1 ? "message" : "messages"} with
      </Text>
      <View style={[styles.a2aPeer, { borderColor: theme.border }]}>
        <BotAvatar bot={peer} color={peer?.color ?? "#858580"} size={20} />
        <Text numberOfLines={1} style={[styles.a2aPeerName, { color: theme.text }]}>
          {name}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ConversationScreen() {
  const theme = useChatTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useChatKeyboard();
  const composerBottomInset = keyboardVisible ? 18 : Math.max(12, insets.bottom - 4);
  const { channelId, messageId } = useLocalSearchParams<{
    channelId: string;
    messageId?: string;
  }>();
  const {
    snapshot,
    capabilities,
    connection,
    sendMessage,
    resendFailedMessage,
    deleteFailedMessage,
    cancelQueuedMessage,
    deliveryRecoveries,
    acknowledgeDeliveryRecovery,
    uploadAsset,
    transcribeAudio,
    assetUrl,
    reactToMessage,
    respondToWidget,
    dismissWidget,
    submitSecret,
    mutateComputerHandoff,
    resolveApproval,
    markChannelRead,
    sidebarPreferences,
    updateSidebarPreferences,
    hydrateChannel,
    releaseChannel,
    loadEarlierMessages,
    loadLaterMessages,
    jumpToLatestMessages,
    setHistoryViewport,
    visibleHistoryMessageIds,
    historyState,
    cancelRun,
  } = useOpenTeam();
  const isFocused = useIsFocused();
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [replyEditVersion, setReplyEditVersion] = useState(0);
  const [composerRecovery, setComposerRecovery] = useState<ComposerRecovery | null>(null);
  const presentedRecoveryNonces = useRef(new Set<string>());
  const [visibleReadSequence, setVisibleReadSequence] = useState<string | null>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [a2aPeerId, setA2APeerId] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(50);
  const listRef = useRef<FlatList<ConversationTimelineEntry>>(null);
  const atLiveEdgeRef = useRef(!messageId);
  const visibleMessageIds = useRef<readonly string[]>([]);
  const jumpingToLatest = useRef(false);
  const historyViewportRef = useRef({ channelId, setHistoryViewport, threadRootId });
  historyViewportRef.current = { channelId, setHistoryViewport, threadRootId };
  const knownMessageKeys = useRef<Set<string> | null>(null);
  const knownChannelId = useRef(channelId);
  const channel = snapshot.channels.find((candidate) => candidate.id === channelId);
  const botId = channel?.kind === "bot_dm" ? channel.members[0]?.botId : undefined;
  const botById = useMemo(
    () => new Map(snapshot.bots.map((candidate) => [candidate.id, candidate] as const)),
    [snapshot.bots]
  );
  const channelById = useMemo(
    () => new Map(snapshot.channels.map((candidate) => [candidate.id, candidate] as const)),
    [snapshot.channels]
  );
  const bot = botId ? botById.get(botId) : undefined;
  const messages = useMemo(() => {
    const visible = visibleHistoryMessageIds(channelId);
    return snapshot.channelMessages.filter(
      (message) =>
        message.channelId === channelId &&
        (!visible || visible.has(message.id) || Boolean(metadataFor(message).clientDelivery))
    );
  }, [channelId, snapshot.channelMessages, visibleHistoryMessageIds]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  useEffect(() => {
    if (composerRecovery) return;
    const recovery = deliveryRecoveries.find(
      (record) =>
        record.target.channelId === channelId &&
        record.payload.isFork !== true &&
        !presentedRecoveryNonces.current.has(record.nonce)
    );
    if (!recovery) return;
    presentedRecoveryNonces.current.add(recovery.nonce);
    setComposerRecovery({
      id: recovery.nonce,
      text: recovery.payload.content,
      attachments: recovery.payload.attachments,
      stagedAttachments: recovery.payload.stagedAttachments,
      replyTarget: recovery.payload.replyToMessageId
        ? {
            id: recovery.payload.replyToMessageId,
            content: byId.get(recovery.payload.replyToMessageId)?.content ?? "Reply",
          }
        : null,
    });
  }, [byId, channelId, composerRecovery, deliveryRecoveries]);
  const threads = useMemo(() => deriveThreads(messages), [messages]);
  const threadRootByReplyId = useMemo(() => {
    const roots = new Map<string, string>();
    for (const [rootId, thread] of threads) {
      for (const reply of thread.replies) roots.set(reply.id, rootId);
    }
    return roots;
  }, [threads]);
  const focusedThreadRootId = messageId ? (threadRootByReplyId.get(messageId) ?? null) : null;
  const mainMessages = useMemo(
    () => messages.filter((message) => !threadRootByReplyId.has(message.id)),
    [messages, threadRootByReplyId]
  );
  const timeline = useMemo<ConversationTimelineEntry[]>(
    () =>
      channel?.kind === "bot_dm"
        ? collapseA2ATimeline(mainMessages, (message) => message)
        : mainMessages,
    [channel?.kind, mainMessages]
  );
  const activeThread = useMemo(() => {
    if (!threadRootId) return null;
    const existing = threads.get(threadRootId);
    if (existing) return existing;
    const root = byId.get(threadRootId);
    return root ? { root, replies: [] } : null;
  }, [byId, threadRootId, threads]);
  const channelHistory = historyState[channelId];
  const unreadBoundary = useChatUnreadBoundary(
    channelId,
    messages,
    // Activity notifications (e.g. reactions) do not mark a new chat message.
    unreadChatMessageCount(channel),
    channelHistory
  );
  const chatScroll = useChatScroll(
    listRef,
    (next) => {
      atLiveEdgeRef.current = next;
      const viewport = historyViewportRef.current;
      if (!viewport.threadRootId)
        viewport.setHistoryViewport(viewport.channelId, visibleMessageIds.current, next);
    },
    channelHistory?.hasNewer
  );
  const {
    following: atLiveEdge,
    setFollowing: updateLiveEdge,
    reset: resetScroll,
    correctAfterLayout,
  } = chatScroll;
  const activeThreadHasMore = activeThread
    ? mayHaveEarlierThreadReplies(
        activeThread.root.sequence,
        channelHistory?.beforeSequence,
        channelHistory?.hasMore ?? false
      )
    : false;
  const a2aExchange = useMemo<MobileA2AExchange | null>(() => {
    if (!a2aPeerId || !bot) return null;
    const peer = botById.get(a2aPeerId);
    if (!peer) return null;
    const exchangeMessages = selectA2AExchangeMessages(mainMessages, a2aPeerId);
    return exchangeMessages.length > 0 ? { source: bot, peer, messages: exchangeMessages } : null;
  }, [a2aPeerId, bot, botById, mainMessages]);
  const pluginMentions = usePluginMentions(botId ?? channel?.members[0]?.botId);
  const mentionOptions = useMemo(() => {
    if (channel?.kind !== "group") return pluginMentions;
    return [
      ...pluginMentions,
      { id: "everyone", label: "Everyone", handle: "everyone" },
      ...channel.members.flatMap((member) => {
        const memberBot = botById.get(member.botId);
        return memberBot
          ? [
              {
                id: memberBot.id,
                label: memberBot.name,
                handle: mentionHandleFor(memberBot.name),
              },
            ]
          : [];
      }),
    ];
  }, [botById, channel, pluginMentions]);
  const enteringMessageKeys = useMemo(() => {
    const known = knownChannelId.current === channelId ? knownMessageKeys.current : null;
    return enteringAppendedMessageKeys(mainMessages, known, messageRenderKey);
  }, [channelId, mainMessages]);
  useEffect(() => {
    knownChannelId.current = channelId;
    knownMessageKeys.current = new Set(mainMessages.map(messageRenderKey));
  }, [channelId, mainMessages]);
  const targetIndex = messageId
    ? timeline.findIndex((entry) =>
        isA2AActivity(entry)
          ? entry.entries.some((message) => message.id === messageId)
          : entry.id === messageId
      )
    : -1;
  const activeRun = snapshot.runs.find(
    (run) => run.channelId === channelId && isActiveRunStatus(run.status)
  );
  const approvals = activeRun
    ? snapshot.approvals.filter(
        (approval) => approval.runId === activeRun.id && approval.status === "pending"
      )
    : [];
  const name = bot?.name ?? channel?.name ?? "OpenTeam";
  const draftAccountIdentity =
    getAuthAccountIdForServer(connection.serverUrl) ??
    getAuthTokenForServer(connection.serverUrl) ??
    "local";
  const draftKey = useMemo(
    () => conversationDraftKey(connection.serverUrl, channelId, draftAccountIdentity),
    [channelId, connection.serverUrl, draftAccountIdentity]
  );
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 10,
    minimumViewTime: 100,
  }).current;
  const messageFocus = useMessageFocus(listRef, messageId, targetIndex);
  const focusVisibleIds = messageFocus.onVisibleMessageIds;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<ConversationTimelineEntry>[] }) => {
      const highest = highestVisibleSequence(
        viewableItems.map(({ isViewable, item }) => ({
          isViewable,
          item: isA2AActivity(item) ? (item.entries.at(-1) ?? null) : item,
        }))
      );
      if (highest) setVisibleReadSequence((current) => laterSequence(current, highest));
      const ids = viewableItems.flatMap(({ isViewable, item }) =>
        !isViewable
          ? []
          : isA2AActivity(item)
            ? item.entries.map((message) => message.id)
            : [item.id]
      );
      visibleMessageIds.current = ids;
      focusVisibleIds(ids);
      const viewport = historyViewportRef.current;
      if (!viewport.threadRootId)
        viewport.setHistoryViewport(viewport.channelId, ids, atLiveEdgeRef.current);
    }
  ).current;

  const selectReply = useCallback((target: ReplyTarget) => {
    setReplyTarget(target);
    setReplyEditVersion((current) => current + 1);
  }, []);
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyEditVersion((current) => current + 1);
  }, []);
  const markConversationUnread = useCallback(async () => {
    if (sidebarPreferences.unreadIds.includes(channelId)) return;
    try {
      await updateSidebarPreferences(addSidebarUnread(sidebarPreferences, [channelId]));
    } catch (cause) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        "Could not mark as unread",
        clientErrorMessage(cause, "OpenTeam could not update this conversation.")
      );
    }
  }, [channelId, sidebarPreferences, updateSidebarPreferences]);

  const recoverCancelledMessage = useCallback(
    async (nonce: string) => {
      try {
        const payload = await cancelQueuedMessage(nonce);
        if (!payload) return;
        const recoveredReply = payload.replyToMessageId
          ? {
              id: payload.replyToMessageId,
              content: byId.get(payload.replyToMessageId)?.content ?? "Reply",
            }
          : null;
        setComposerRecovery({
          id: nonce,
          text: payload.content,
          attachments: payload.attachments,
          stagedAttachments: payload.stagedAttachments,
          replyTarget: recoveredReply,
        });
      } catch (cause) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          "Message not cancelled",
          clientErrorMessage(cause, "OpenTeam could not cancel this message.")
        );
      }
    },
    [byId, cancelQueuedMessage]
  );

  const resendFailed = useCallback(
    async (nonce: string) => {
      try {
        await resendFailedMessage(nonce);
      } catch (cause) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          "Message not resent",
          clientErrorMessage(cause, "OpenTeam could not resend this message.")
        );
      }
    },
    [resendFailedMessage]
  );

  const deleteFailed = useCallback(
    async (nonce: string) => {
      try {
        await deleteFailedMessage(nonce);
      } catch (cause) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          "Message not deleted",
          clientErrorMessage(cause, "OpenTeam could not delete this message.")
        );
      }
    },
    [deleteFailedMessage]
  );

  const recordVisibleSequence = useCallback((sequence: string) => {
    setVisibleReadSequence((current) => laterSequence(current, sequence));
  }, []);

  const handleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      try {
        await reactToMessage(messageId, emoji);
      } catch (cause) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          "Reaction not sent",
          clientErrorMessage(cause, "OpenTeam could not update this reaction.")
        );
      }
    },
    [reactToMessage]
  );

  const openRoutine = useCallback(
    (routineId: string) => router.push(routineRoute(channelId, routineId)),
    [channelId]
  );

  useEffect(() => {
    if (!threadRootId)
      setHistoryViewport(channelId, visibleMessageIds.current, atLiveEdgeRef.current);
  }, [channelId, setHistoryViewport, threadRootId]);

  useEffect(() => {
    knownChannelId.current = channelId;
    jumpingToLatest.current = false;
    visibleMessageIds.current = [];
    setVisibleReadSequence(null);
    setA2APeerId(null);
    resetScroll(!messageId);
  }, [channelId, messageId, resetScroll]);

  useEffect(() => {
    if (focusedThreadRootId) setThreadRootId(focusedThreadRootId);
  }, [focusedThreadRootId]);

  useEffect(() => {
    if (!messageId) return;
    const focusedMessage = byId.get(messageId);
    const peerId = focusedMessage ? a2aProjectionFor(focusedMessage)?.peerId : null;
    if (peerId && botById.has(peerId)) setA2APeerId(peerId);
  }, [botById, byId, messageId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Footer changes can precede the native content-size event.
  useEffect(() => {
    correctAfterLayout();
  }, [activeRun?.id, approvals.length, timeline.length, composerHeight, correctAfterLayout]);

  useFocusEffect(
    useCallback(() => {
      setActiveNotificationChannel(channelId);
      void hydrateChannel(channelId, messageId);
      return () => {
        setActiveNotificationChannel(null);
        releaseChannel(channelId);
      };
    }, [channelId, hydrateChannel, messageId, releaseChannel])
  );

  const unreadCount = channel?.unreadCount ?? 0;
  useEffect(() => {
    if (!isFocused || visibleReadSequence === null || !Number.isFinite(unreadCount)) return;
    void markChannelRead(channelId, visibleReadSequence);
  }, [channelId, isFocused, markChannelRead, unreadCount, visibleReadSequence]);

  return (
    <View style={[styles.safe, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.flex}
      >
        {/* Absolute overlays must be inside the keyboard-resized content area. */}
        <View testID="chat-keyboard-content" style={styles.flex}>
          <ChatChromeFade
            edge="top"
            style={{ bottom: undefined, height: insets.top + 104, zIndex: 2 }}
          />
          <View style={[styles.header, { top: insets.top + 6 }]}>
            <NativeGlassButton
              label="Back"
              symbol="chevron.left"
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
              symbolSize={14.5}
              fallbackSymbolSize={18}
              symbolOffsetX={1}
              style={{ width: 44, height: 44 }}
            />
            <NativeGlassButton
              label={`${name} conversation details`}
              onPress={() =>
                router.push({ pathname: "/details/[channelId]", params: { channelId } })
              }
              style={styles.identityButton}
            >
              <View style={styles.identity}>
                <View style={styles.headerAvatar}>
                  <BotAvatar
                    bot={bot}
                    color={bot?.color ?? "#858580"}
                    size={27}
                    artworkScale={1.1}
                  />
                  {activeRun ? (
                    <View style={[styles.activityDot, { borderColor: theme.background }]} />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                  {name}
                </Text>
              </View>
            </NativeGlassButton>
            <NativeGlassButton
              style={styles.headerTrailingAction}
              label="Open shared computer"
              symbol="display"
              disabled={!botId}
              onPress={() => {
                if (!botId) return;
                router.push({ pathname: "/computer/[botId]", params: { botId } });
              }}
              symbolSize={12.5}
              fallbackSymbolSize={22}
            />
          </View>

          <View style={styles.timeline}>
            <FlatList
              {...MOBILE_VIRTUAL_LIST_TUNING}
              ref={listRef}
              data={timeline}
              keyExtractor={(entry) => (isA2AActivity(entry) ? entry.id : messageRenderKey(entry))}
              contentContainerStyle={[
                styles.messages,
                timeline.length === 0 && styles.emptyMessages,
                { paddingTop: insets.top + 66, paddingBottom: composerHeight + 15 },
              ]}
              ListEmptyComponent={
                bot?.onboardingStatus === "completed" && !channelHistory?.loading ? (
                  <Text style={[styles.emptyMessageLabel, { color: theme.textMuted }]}>
                    No messages yet
                  </Text>
                ) : null
              }
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              maintainVisibleContentPosition={atLiveEdge ? undefined : { minIndexForVisible: 0 }}
              onContentSizeChange={chatScroll.onContentSizeChange}
              onLayout={chatScroll.onLayout}
              onScrollBeginDrag={() => {
                messageFocus.cancel();
                chatScroll.onScrollBeginDrag();
              }}
              onScrollEndDrag={chatScroll.onScrollEndDrag}
              onMomentumScrollBegin={chatScroll.onMomentumScrollBegin}
              onMomentumScrollEnd={chatScroll.onMomentumScrollEnd}
              onScroll={(event) => {
                if (jumpingToLatest.current) return;
                chatScroll.onScroll(event);
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                if (
                  channelHistory?.hasNewer &&
                  !threadRootId &&
                  isNearLiveEdge(contentOffset.y, layoutMeasurement.height, contentSize.height)
                )
                  void loadLaterMessages(channelId);
              }}
              onScrollToIndexFailed={messageFocus.onScrollToIndexFailed}
              onViewableItemsChanged={onViewableItemsChanged}
              onEndReached={() => {
                if (channelHistory?.hasNewer && !threadRootId) void loadLaterMessages(channelId);
              }}
              onEndReachedThreshold={0.5}
              scrollEventThrottle={32}
              viewabilityConfig={viewabilityConfig}
              renderItem={({ item, index }) => {
                const first = isA2AActivity(item) ? item.entries[0]! : item;
                const last = isA2AActivity(item) ? item.entries.at(-1)! : item;
                const previous = timeline[index - 1];
                const previousMessage =
                  previous && (isA2AActivity(previous) ? previous.entries.at(-1) : previous);
                const frameProps = {
                  createdAt: first.createdAt,
                  previousCreatedAt: previousMessage?.createdAt,
                  isNew: crossesUnreadBoundary(
                    previousMessage?.sequence,
                    last.sequence,
                    unreadBoundary
                  ),
                };
                if (isA2AActivity(item)) {
                  const peer = item.peerId ? botById.get(item.peerId) : undefined;
                  const group = item.peerId ? channelById.get(item.peerId) : undefined;
                  const onOpen = peer
                    ? () => setA2APeerId(peer.id)
                    : group?.kind === "group"
                      ? () =>
                          router.push({
                            pathname: "/chat/[channelId]",
                            params: { channelId: group.id },
                          })
                      : undefined;
                  return (
                    <ConversationMessageFrame {...frameProps}>
                      <A2AActivityRow
                        count={item.entries.length}
                        onOpen={onOpen}
                        peer={peer}
                        peerName={item.peerName ?? group?.name ?? "another agent"}
                      />
                    </ConversationMessageFrame>
                  );
                }
                const metadata = metadataFor(item);
                const replyId = metadata.replyTo;
                const replyPreview =
                  typeof replyId === "string" ? byId.get(replyId)?.content : null;
                const peer = metadata.fromAgent ?? metadata.toAgent;
                const peerId =
                  peer && typeof peer === "object" && !Array.isArray(peer)
                    ? (peer as Record<string, unknown>).id
                    : null;
                const peerBot = typeof peerId === "string" ? botById.get(peerId) : undefined;
                const groupSpeaker =
                  channel?.kind === "group" && item.senderBotId
                    ? botById.get(item.senderBotId)
                    : undefined;
                const clientDelivery = clientDeliveryFor(item);
                const deliveryState = clientDelivery?.state;
                const deliveryNonce = clientDelivery?.nonce;
                const deliveryComposedAtMs = clientDelivery?.composedAtMs;
                const deliveryQueuedAtMs = clientDelivery?.queuedAtMs;
                const deliveryAcceptedAtMs = clientDelivery?.acceptedAtMs;
                const renderKey = messageRenderKey(item);
                const thread = threads.get(item.id);
                const threadReplyCountIsPartial = thread
                  ? mayHaveEarlierThreadReplies(
                      thread.root.sequence,
                      channelHistory?.beforeSequence,
                      channelHistory?.hasMore ?? false
                    )
                  : false;
                return (
                  <ConversationMessageFrame {...frameProps}>
                    <MessageBubble
                      animateEntrance={enteringMessageKeys.has(renderKey)}
                      message={item}
                      pending={deliveryState === "pending" || deliveryState === "queued"}
                      showSpeakerName={Boolean(groupSpeaker)}
                      speakerName={groupSpeaker?.name}
                      deliveryState={
                        deliveryState === "pending" ||
                        deliveryState === "queued" ||
                        deliveryState === "accepted" ||
                        deliveryState === "failed"
                          ? deliveryState
                          : undefined
                      }
                      deliveryNonce={typeof deliveryNonce === "string" ? deliveryNonce : undefined}
                      deliveryComposedAtMs={
                        typeof deliveryComposedAtMs === "number" ? deliveryComposedAtMs : null
                      }
                      deliveryQueuedAtMs={
                        typeof deliveryQueuedAtMs === "number" ? deliveryQueuedAtMs : null
                      }
                      deliveryAcceptedAtMs={
                        typeof deliveryAcceptedAtMs === "number" ? deliveryAcceptedAtMs : null
                      }
                      deliveryTransportDown={clientDelivery?.transportDown === true}
                      onResendFailed={(nonce) => void resendFailed(nonce)}
                      onDeleteFailed={(nonce) => void deleteFailed(nonce)}
                      onCancelQueued={(nonce) => void recoverCancelledMessage(nonce)}
                      peerBot={peerBot}
                      replyPreview={replyPreview}
                      assetUrl={assetUrl}
                      onReply={() => selectReply({ id: item.id, content: item.content })}
                      onStartThread={() => setThreadRootId(item.id)}
                      onMarkUnread={() => void markConversationUnread()}
                      onReport={() =>
                        Alert.alert(
                          "Report message",
                          "Message reporting is not available on this self-hosted server."
                        )
                      }
                      onReact={(emoji) => void handleReaction(item.id, emoji)}
                      onWidgetResponse={(value) => respondToWidget(item.id, value)}
                      onWidgetDismiss={() => dismissWidget(item.id)}
                      onSecretSubmit={(value) => submitSecret(item.id, value)}
                      onComputerHandoff={(action) => mutateComputerHandoff(item.id, action)}
                      onOpenThread={thread ? () => setThreadRootId(item.id) : undefined}
                      onOpenRoutine={openRoutine}
                      threadReplyCount={thread?.replies.length ?? 0}
                      threadReplyCountIsPartial={threadReplyCountIsPartial}
                    />
                  </ConversationMessageFrame>
                );
              }}
              ListHeaderComponent={
                historyState[channelId]?.loading ? (
                  <ActivityIndicator color={theme.textMuted} style={styles.historyAction} />
                ) : historyState[channelId]?.hasMore ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      updateLiveEdge(false);
                      void loadEarlierMessages(channelId);
                    }}
                    style={({ pressed }) => [styles.historyAction, pressed && { opacity: 0.65 }]}
                  >
                    <Text style={[styles.historyLabel, { color: theme.textMuted }]}>
                      Load earlier messages
                    </Text>
                  </Pressable>
                ) : null
              }
              ListFooterComponent={
                <View>
                  {approvals.map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      onResolve={(decision) => resolveApproval(approval.id, decision)}
                    />
                  ))}
                  <WorkingIndicator
                    key={channelId}
                    visible={Boolean(activeRun) && approvals.length === 0}
                    name={name}
                    bot={activeRun ? (botById.get(activeRun.botId) ?? bot) : bot}
                    active={isFocused}
                    onStop={activeRun ? () => void cancelRun(activeRun.id) : undefined}
                  />
                </View>
              }
            />
            {!atLiveEdge && timeline.length > 0 ? (
              <Pressable
                accessibilityLabel={
                  (channel?.unreadCount ?? 0) > 0
                    ? `Jump to latest, ${channel?.unreadCount} unread`
                    : "Jump to latest"
                }
                accessibilityRole="button"
                hitSlop={4}
                onPress={() => {
                  messageFocus.cancel();
                  updateLiveEdge(true);
                  if (!channelHistory?.hasNewer) {
                    correctAfterLayout();
                    return;
                  }
                  jumpingToLatest.current = true;
                  void jumpToLatestMessages(channelId).finally(() => {
                    requestAnimationFrame(() => {
                      if (historyViewportRef.current.channelId !== channelId) return;
                      jumpingToLatest.current = false;
                      updateLiveEdge(true);
                      correctAfterLayout();
                    });
                  });
                }}
                style={({ pressed }) => [
                  styles.jumpButton,
                  { bottom: composerHeight + 12, right: keyboardVisible ? 18 : 30 },
                  pressed && styles.jumpButtonPressed,
                ]}
              >
                <GlassSurface
                  fallbackColor={theme.surfaceElevated}
                  interactive
                  variant="clear"
                  tintColor={theme.dark ? chatGlassTint : undefined}
                  style={styles.jumpSurface}
                >
                  <SymbolView
                    name="chevron.down"
                    size={15}
                    tintColor={theme.text}
                    weight="semibold"
                  />
                </GlassSurface>
              </Pressable>
            ) : null}
          </View>

          <View
            onLayout={(event) => {
              const measuredHeight = Math.ceil(event.nativeEvent.layout.height);
              setComposerHeight((current) =>
                current === measuredHeight ? current : measuredHeight
              );
            }}
            style={[styles.composerOverlay, { paddingBottom: composerBottomInset }]}
          >
            <ChatChromeFade edge="bottom" />
            <Composer
              keyboardVisible={keyboardVisible}
              transcriptionConfigured={
                snapshot?.runtime.transcription === "configured" && !activeThread
              }
              onTranscribe={transcribeAudio}
              draftKey={draftKey}
              botName={name}
              mentionOptions={mentionOptions}
              recovery={composerRecovery}
              onRecoveryApplied={(id) => {
                setComposerRecovery((current) => (current?.id === id ? null : current));
              }}
              onRecoveryConsumed={acknowledgeDeliveryRecovery}
              replyTarget={replyTarget}
              replyEditVersion={replyEditVersion}
              onRestoreReply={setReplyTarget}
              onClearReply={clearReply}
              assetUrl={assetUrl}
              onUpload={uploadAsset}
              onSend={async (content, attachments, stagedAttachments, consumedDraft) => {
                messageFocus.cancel();
                updateLiveEdge(true);
                await sendMessage(channelId, content, attachments, replyTarget?.id, {
                  consumedDraft,
                  stagedAttachments,
                });
                setReplyTarget(null);
                if (channelHistory?.hasNewer) await jumpToLatestMessages(channelId);
                correctAfterLayout();
              }}
              onStage={stageMobileDeliveryAttachment}
              onDiscardStages={discardMobileDeliveryAttachments}
              uploadCapabilities={capabilities.uploads}
            />
          </View>
          {activeThread ? (
            <ThreadSheet
              transcriptionConfigured={snapshot?.runtime.transcription === "configured"}
              onTranscribe={transcribeAudio}
              assetUrl={assetUrl}
              botById={botById}
              botName={name}
              draftKey={draftKey}
              historyHasMore={activeThreadHasMore}
              historyLoading={channelHistory?.loading ?? false}
              mentionOptions={mentionOptions}
              onClose={() => setThreadRootId(null)}
              onLoadEarlier={() => loadEarlierMessages(channelId)}
              onLoadLater={() =>
                channelHistory?.hasNewer ? loadLaterMessages(channelId) : Promise.resolve()
              }
              historyHasNewer={channelHistory?.hasNewer ?? false}
              onVisibleMessageIds={(ids, atBottom) =>
                setHistoryViewport(channelId, ids, atBottom && !channelHistory?.hasNewer)
              }
              onReact={handleReaction}
              onResendFailed={resendFailed}
              onDeleteFailed={deleteFailed}
              onCancelQueued={cancelQueuedMessage}
              deliveryRecoveries={deliveryRecoveries.filter(
                (record) => record.target.channelId === channelId && record.payload.isFork === true
              )}
              onAcknowledgeRecovery={acknowledgeDeliveryRecovery}
              onSecretSubmit={submitSecret}
              onComputerHandoff={mutateComputerHandoff}
              onSend={(content, attachments, stagedAttachments, replyToMessageId, consumedDraft) =>
                sendMessage(channelId, content, attachments, replyToMessageId, {
                  isFork: true,
                  consumedDraft,
                  stagedAttachments,
                })
              }
              onUpload={uploadAsset}
              onVisibleSequence={recordVisibleSequence}
              onWidgetDismiss={dismissWidget}
              onWidgetResponse={respondToWidget}
              targetMessageId={focusedThreadRootId === threadRootId ? messageId : undefined}
              thread={activeThread}
              uploadCapabilities={capabilities.uploads}
            />
          ) : null}
          {a2aExchange ? (
            <A2AExchangeSheet
              assetUrl={assetUrl}
              exchange={a2aExchange}
              onClose={() => setA2APeerId(null)}
              onOpenComputer={() => {
                if (bot) router.push(`/computer/${bot.id}`);
              }}
            />
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  timeline: { flex: 1 },
  composerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
  },
  header: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 3,
    minHeight: 44,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTrailingAction: { marginLeft: "auto" },
  identityButton: { flexShrink: 1, minWidth: 0, minHeight: 44, justifyContent: "center" },
  headerAvatar: { width: 27, height: 27 },
  activityDot: {
    position: "absolute",
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: "#35a96b",
    right: 0,
    bottom: 0,
  },
  identity: {
    maxWidth: "100%",
    minHeight: 44,
    borderRadius: 22,
    paddingLeft: 10,
    paddingRight: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  title: { flexShrink: 1, fontSize: 17, lineHeight: 22, fontWeight: "500" },
  messages: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
  },
  emptyMessages: { justifyContent: "center", alignItems: "center" },
  emptyMessageLabel: { fontSize: 15, lineHeight: 20 },
  historyAction: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  historyLabel: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  a2aActivity: {
    minHeight: 42,
    marginVertical: 4,
    borderRadius: 16,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  a2aActivityText: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  a2aPeer: {
    maxWidth: 180,
    minHeight: 30,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 15,
    paddingHorizontal: 5,
    paddingRight: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  a2aPeerName: { flexShrink: 1, fontSize: 12, lineHeight: 16, fontWeight: "600" },
  jumpButton: {
    position: "absolute",
    borderRadius: 18,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  jumpButtonPressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  jumpSurface: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
});
