import type { ChannelMessageView } from "@openbot/contracts";
import { mentionHandleFor } from "@openbot/product-core/mentions";
import { clientErrorMessage } from "@openbot/product-core/redaction";
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
} from "@openbot/product-core/messages";
import { isActiveRunStatus } from "@openbot/product-core/statuses";
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
import { SafeAreaView } from "react-native-safe-area-context";
import {
  enteringAppendedMessageKeys,
  highestVisibleSequence,
  isNearLiveEdge,
  laterSequence,
} from "../../src/chat-viewport";
import { A2AExchangeSheet, type MobileA2AExchange } from "../../src/components/a2a-exchange-sheet";
import { ApprovalCard } from "../../src/components/approval-card";
import { BotMark } from "../../src/components/bot-mark";
import { Composer, type ComposerRecovery, type ReplyTarget } from "../../src/components/composer";
import { GlassSurface } from "../../src/components/glass-surface";
import { IconButton } from "../../src/components/icon-button";
import { MessageBubble } from "../../src/components/message-bubble";
import { RunActivitySheet } from "../../src/components/run-activity-sheet";
import { ThreadSheet } from "../../src/components/thread-sheet";
import { WorkingIndicator } from "../../src/components/working-indicator";
import { conversationDraftKey } from "../../src/drafts";
import {
  discardMobileDeliveryAttachments,
  stageMobileDeliveryAttachment,
} from "../../src/durable-attachment-stage";
import { getAuthAccountIdForServer, getAuthTokenForServer } from "../../src/auth";
import { MOBILE_VIRTUAL_LIST_TUNING } from "../../src/list-scale";
import { setActiveNotificationChannel } from "../../src/notifications";
import { useOpenBot } from "../../src/state/openbot-context";
import { useTheme } from "../../src/theme";

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
  peer?: { color: string; icon: string; name: string };
  peerName: string;
}) {
  const theme = useTheme();
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
        <BotMark color={peer?.color ?? "#858580"} icon={peer?.icon} size={20} />
        <Text numberOfLines={1} style={[styles.a2aPeerName, { color: theme.text }]}>
          {name}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ConversationScreen() {
  const theme = useTheme();
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
    uploadAsset,
    assetUrl,
    reactToMessage,
    respondToWidget,
    dismissWidget,
    submitSecret,
    resolveApproval,
    markChannelRead,
    hydrateChannel,
    releaseChannel,
    loadEarlierMessages,
    historyState,
    activityTruncated,
    activityCounts,
    cancelRun,
  } = useOpenBot();
  const isFocused = useIsFocused();
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [replyEditVersion, setReplyEditVersion] = useState(0);
  const [composerRecovery, setComposerRecovery] = useState<ComposerRecovery | null>(null);
  const [visibleReadSequence, setVisibleReadSequence] = useState<string | null>(null);
  const [atLiveEdge, setAtLiveEdge] = useState(!messageId);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [a2aPeerId, setA2APeerId] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const listRef = useRef<FlatList<ConversationTimelineEntry>>(null);
  const atLiveEdgeRef = useRef(!messageId);
  const didPlaceInitialScroll = useRef(false);
  const targetScrollRetries = useRef(0);
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
  const messages = useMemo(
    () => snapshot.channelMessages.filter((message) => message.channelId === channelId),
    [channelId, snapshot.channelMessages]
  );
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
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
  const activeThread = threadRootId ? (threads.get(threadRootId) ?? null) : null;
  const channelHistory = historyState[channelId];
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
  const mentionOptions = useMemo(() => {
    if (channel?.kind !== "group") return [];
    return [
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
  }, [botById, channel]);
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
  const channelRuns = useMemo(
    () => (activityOpen ? snapshot.runs.filter((run) => run.channelId === channelId) : []),
    [activityOpen, channelId, snapshot.runs]
  );
  const channelRunIds = useMemo(() => new Set(channelRuns.map((run) => run.id)), [channelRuns]);
  const channelRunItems = useMemo(
    () => (activityOpen ? snapshot.runItems.filter((item) => channelRunIds.has(item.runId)) : []),
    [activityOpen, channelRunIds, snapshot.runItems]
  );
  const channelSubagents = useMemo(
    () =>
      activityOpen
        ? snapshot.subagents.filter((subagent) => subagent.parentChannelId === channelId)
        : [],
    [activityOpen, channelId, snapshot.subagents]
  );
  const channelActivityCount = activityCounts[channelId] ?? 0;
  const name = bot?.name ?? channel?.name ?? "OpenBot";
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
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<ConversationTimelineEntry>[] }) => {
      const highest = highestVisibleSequence(
        viewableItems.map(({ isViewable, item }) => ({
          isViewable,
          item: isA2AActivity(item) ? (item.entries.at(-1) ?? null) : item,
        }))
      );
      if (highest) setVisibleReadSequence((current) => laterSequence(current, highest));
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
        Alert.alert(
          "Message not cancelled",
          clientErrorMessage(cause, "OpenBot could not cancel this message.")
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
        Alert.alert(
          "Message not resent",
          clientErrorMessage(cause, "OpenBot could not resend this message.")
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
        Alert.alert(
          "Message not deleted",
          clientErrorMessage(cause, "OpenBot could not delete this message.")
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
        Alert.alert(
          "Reaction not sent",
          clientErrorMessage(cause, "OpenBot could not update this reaction.")
        );
      }
    },
    [reactToMessage]
  );

  const updateLiveEdge = useCallback((next: boolean) => {
    atLiveEdgeRef.current = next;
    setAtLiveEdge((current) => (current === next ? current : next));
  }, []);

  useEffect(() => {
    knownChannelId.current = channelId;
    didPlaceInitialScroll.current = false;
    targetScrollRetries.current = 0;
    setVisibleReadSequence(null);
    setA2APeerId(null);
    updateLiveEdge(!messageId);
  }, [channelId, messageId, updateLiveEdge]);

  useEffect(() => {
    if (focusedThreadRootId) setThreadRootId(focusedThreadRootId);
  }, [focusedThreadRootId]);

  useEffect(() => {
    if (!messageId) return;
    const focusedMessage = byId.get(messageId);
    const peerId = focusedMessage ? a2aProjectionFor(focusedMessage)?.peerId : null;
    if (peerId && botById.has(peerId)) setA2APeerId(peerId);
  }, [botById, byId, messageId]);

  useEffect(() => {
    if (!messageId || targetIndex < 0 || didPlaceInitialScroll.current) return;
    const frame = requestAnimationFrame(() => {
      didPlaceInitialScroll.current = true;
      listRef.current?.scrollToIndex({
        index: targetIndex,
        animated: false,
        viewPosition: 0.5,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [messageId, targetIndex]);

  useEffect(() => {
    if (messageId || !didPlaceInitialScroll.current || !atLiveEdgeRef.current) return;
    // FlatList's maintained position can briefly win over onContentSizeChange
    // when a group round appends messages while its working footer is removed.
    // Reassert the live edge after both React and the native list settle so the
    // completed exchange cannot be left rendered beyond the visible viewport.
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
    });
    const settled = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: false });
    }, 120);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settled);
    };
  }, [activeRun?.id, approvals.length, channelActivityCount, messageId, timeline.length]);

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
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.flex}
      >
        <View style={styles.header}>
          <IconButton
            label="Back"
            name="chevron.left"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
            size={38}
            symbolSize={18}
            tone="surface"
          />
          <Pressable
            accessibilityLabel={`${name} conversation details`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/details/[channelId]", params: { channelId } })}
            style={({ pressed }) => pressed && styles.identityPressed}
          >
            <GlassSurface
              fallbackColor={theme.surfaceElevated}
              interactive
              style={[
                styles.identity,
                {
                  borderColor: theme.border,
                  shadowColor: theme.dark ? "#000" : "#77776F",
                },
              ]}
            >
              <BotMark color={bot?.color ?? "#858580"} icon={bot?.icon} size={27} />
              <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                {name}
              </Text>
            </GlassSurface>
          </Pressable>
          <IconButton
            label="Open shared computer"
            name="desktopcomputer"
            disabled={!botId}
            onPress={() => {
              if (!botId) return;
              router.push({ pathname: "/computer/[botId]", params: { botId } });
            }}
            size={38}
            symbolSize={18}
            tone="surface"
          />
        </View>

        <View style={styles.timeline}>
          <FlatList
            {...MOBILE_VIRTUAL_LIST_TUNING}
            ref={listRef}
            data={timeline}
            keyExtractor={(entry) => (isA2AActivity(entry) ? entry.id : messageRenderKey(entry))}
            contentContainerStyle={styles.messages}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onContentSizeChange={() => {
              if (!didPlaceInitialScroll.current) {
                if (messageId && targetIndex < 0) return;
                didPlaceInitialScroll.current = true;
                if (messageId) {
                  listRef.current?.scrollToIndex({
                    index: targetIndex,
                    animated: false,
                    viewPosition: 0.5,
                  });
                } else {
                  listRef.current?.scrollToEnd({ animated: false });
                }
                return;
              }
              if (atLiveEdgeRef.current) listRef.current?.scrollToEnd({ animated: false });
            }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              updateLiveEdge(
                isNearLiveEdge(contentOffset.y, layoutMeasurement.height, contentSize.height)
              );
            }}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({
                animated: false,
                offset: Math.max(0, averageItemLength * index),
              });
              if (targetScrollRetries.current >= 2) return;
              targetScrollRetries.current += 1;
              setTimeout(() => {
                listRef.current?.scrollToIndex({
                  index,
                  animated: false,
                  viewPosition: 0.5,
                });
              }, 80);
            }}
            onViewableItemsChanged={onViewableItemsChanged}
            scrollEventThrottle={32}
            viewabilityConfig={viewabilityConfig}
            renderItem={({ item }) => {
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
                  <A2AActivityRow
                    count={item.entries.length}
                    onOpen={onOpen}
                    peer={peer}
                    peerName={item.peerName ?? group?.name ?? "another agent"}
                  />
                );
              }
              const metadata = metadataFor(item);
              const replyId = metadata.replyTo;
              const replyPreview = typeof replyId === "string" ? byId.get(replyId)?.content : null;
              const peer = metadata.fromAgent ?? metadata.toAgent;
              const peerId =
                peer && typeof peer === "object" && !Array.isArray(peer)
                  ? (peer as Record<string, unknown>).id
                  : null;
              const peerBot = typeof peerId === "string" ? botById.get(peerId) : undefined;
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
                <MessageBubble
                  animateEntrance={enteringMessageKeys.has(renderKey)}
                  message={item}
                  pending={deliveryState === "pending" || deliveryState === "queued"}
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
                  onReact={(emoji) => void handleReaction(item.id, emoji)}
                  onWidgetResponse={(value) => respondToWidget(item.id, value)}
                  onWidgetDismiss={() => dismissWidget(item.id)}
                  onSecretSubmit={(value) => submitSecret(item.id, value)}
                  onOpenThread={thread ? () => setThreadRootId(item.id) : undefined}
                  threadReplyCount={thread?.replies.length ?? 0}
                  threadReplyCountIsPartial={threadReplyCountIsPartial}
                />
              );
            }}
            ListHeaderComponent={
              historyState[channelId]?.loading ? (
                <ActivityIndicator color={theme.textMuted} style={styles.historyAction} />
              ) : historyState[channelId]?.hasMore ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void loadEarlierMessages(channelId)}
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
                {channelActivityCount > 0 ? (
                  <Pressable
                    accessibilityLabel={`Open run activity with ${channelActivityCount} events`}
                    accessibilityRole="button"
                    hitSlop={2}
                    onPress={() => setActivityOpen(true)}
                    style={({ pressed }) => [
                      styles.activityButton,
                      { borderColor: theme.border, opacity: pressed ? 0.65 : 1 },
                    ]}
                  >
                    <SymbolView
                      name="list.bullet.rectangle"
                      size={14}
                      tintColor={theme.textMuted}
                    />
                    <Text style={[styles.activityLabel, { color: theme.textMuted }]}>
                      Run activity
                    </Text>
                  </Pressable>
                ) : null}
                {activeRun && approvals.length === 0 ? (
                  <WorkingIndicator name={name} onStop={() => void cancelRun(activeRun.id)} />
                ) : null}
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
                updateLiveEdge(true);
                listRef.current?.scrollToEnd({ animated: true });
              }}
              style={({ pressed }) => [styles.jumpButton, pressed && styles.jumpButtonPressed]}
            >
              <GlassSurface
                fallbackColor={theme.surfaceElevated}
                interactive
                style={[styles.jumpSurface, { borderColor: theme.border }]}
              >
                <SymbolView name="arrow.down" size={12} tintColor={theme.text} weight="semibold" />
                <Text style={[styles.jumpLabel, { color: theme.text }]}>
                  {(channel?.unreadCount ?? 0) > 0 ? `${channel?.unreadCount} unread` : "Latest"}
                </Text>
              </GlassSurface>
            </Pressable>
          ) : null}
        </View>

        <Composer
          draftKey={draftKey}
          botName={name}
          mentionOptions={mentionOptions}
          recovery={composerRecovery}
          onRecoveryApplied={(id) => {
            setComposerRecovery((current) => (current?.id === id ? null : current));
          }}
          replyTarget={replyTarget}
          replyEditVersion={replyEditVersion}
          onRestoreReply={setReplyTarget}
          onClearReply={clearReply}
          assetUrl={assetUrl}
          onUpload={uploadAsset}
          onSend={async (content, attachments, stagedAttachments, consumedDraft) => {
            await sendMessage(channelId, content, attachments, replyTarget?.id, {
              consumedDraft,
              stagedAttachments,
            });
            setReplyTarget(null);
          }}
          onStage={stageMobileDeliveryAttachment}
          onDiscardStages={discardMobileDeliveryAttachments}
          uploadCapabilities={capabilities.uploads}
        />
        {activeThread ? (
          <ThreadSheet
            assetUrl={assetUrl}
            botById={botById}
            botName={name}
            draftKey={draftKey}
            historyHasMore={activeThreadHasMore}
            historyLoading={channelHistory?.loading ?? false}
            mentionOptions={mentionOptions}
            onClose={() => setThreadRootId(null)}
            onLoadEarlier={() => loadEarlierMessages(channelId)}
            onReact={handleReaction}
            onResendFailed={resendFailed}
            onDeleteFailed={deleteFailed}
            onCancelQueued={cancelQueuedMessage}
            onSecretSubmit={submitSecret}
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
          />
        ) : null}
        {activityOpen ? (
          <RunActivitySheet
            bots={snapshot.bots}
            items={channelRunItems}
            onClose={() => setActivityOpen(false)}
            runs={channelRuns}
            subagents={channelSubagents}
            truncated={activityTruncated[channelId] ?? false}
            visible
          />
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  timeline: { flex: 1 },
  header: {
    height: 56,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  identity: {
    maxWidth: 220,
    minHeight: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 6,
    paddingRight: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    shadowOpacity: 0.08,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 2 },
  },
  identityPressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  title: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  messages: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
  },
  historyAction: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  historyLabel: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  activityButton: {
    minHeight: 40,
    marginHorizontal: 16,
    marginVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  activityLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
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
    bottom: 10,
    alignSelf: "center",
    borderRadius: 18,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  jumpButtonPressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  jumpSurface: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  jumpLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
});
