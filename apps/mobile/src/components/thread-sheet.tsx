import type {
  AssetRef,
  BotView,
  ChannelMessageView,
  ClientCapabilities,
} from "@openteam/contracts";
import type {
  DurableSendPayload,
  DurableSendRecord,
  DurableStagedAttachment,
} from "@openteam/product-core/durable-delivery";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { messageMetadata, type ThreadView } from "@openteam/product-core/messages";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { highestVisibleSequence, isNearLiveEdge } from "../chat-viewport";
import { MOBILE_VIRTUAL_LIST_TUNING } from "../list-scale";
import {
  discardMobileDeliveryAttachments,
  stageMobileDeliveryAttachment,
} from "../durable-attachment-stage";
import { useTheme } from "../theme";
import { Composer, type ComposerRecovery, type ReplyTarget } from "./composer";
import { IconButton } from "./icon-button";
import { MessageBubble } from "./message-bubble";

const clientDeliveryFor = (message: ChannelMessageView) => {
  const candidate = messageMetadata(message).clientDelivery;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
};

const messageRenderKey = (message: ChannelMessageView) => {
  const key = clientDeliveryFor(message)?.renderKey;
  if (typeof key === "string") return key;
  return message.sender === "user" && message.clientId
    ? `optimistic:${message.clientId}`
    : message.id;
};

const threadTimestamp = (createdAt: string) => {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

export function ThreadSheet({
  assetUrl,
  botById,
  botName,
  draftKey,
  historyHasMore,
  historyLoading,
  mentionOptions,
  onClose,
  onLoadEarlier,
  onLoadLater,
  historyHasNewer,
  onVisibleMessageIds,
  onReact,
  onResendFailed,
  onDeleteFailed,
  onCancelQueued,
  deliveryRecoveries,
  onAcknowledgeRecovery,
  onSecretSubmit,
  onComputerHandoff,
  onSend,
  onUpload,
  onVisibleSequence,
  onWidgetDismiss,
  onWidgetResponse,
  targetMessageId,
  thread,
  uploadCapabilities,
}: {
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">, download?: boolean) => string | null;
  botById: ReadonlyMap<string, BotView>;
  botName: string;
  draftKey: string;
  historyHasMore: boolean;
  historyLoading: boolean;
  mentionOptions: Array<{ id: string; label: string; handle: string }>;
  onClose: () => void;
  onLoadEarlier: () => Promise<void>;
  onLoadLater: () => Promise<void>;
  historyHasNewer: boolean;
  onVisibleMessageIds: (ids: readonly string[], atBottom: boolean) => void;
  onReact: (messageId: string, emoji: string) => Promise<void>;
  onResendFailed: (nonce: string) => Promise<void>;
  onDeleteFailed: (nonce: string) => Promise<void>;
  onCancelQueued: (nonce: string) => Promise<DurableSendPayload | null>;
  deliveryRecoveries: readonly DurableSendRecord[];
  onAcknowledgeRecovery: (nonce: string) => Promise<void>;
  onSecretSubmit: (messageId: string, value: string) => Promise<boolean>;
  onComputerHandoff: (messageId: string, action: "start" | "skip") => Promise<boolean>;
  onSend: (
    content: string,
    attachments: readonly AssetRef[],
    stagedAttachments: DurableStagedAttachment[],
    replyToMessageId: string,
    consumedDraft: { key: string; id: string }
  ) => Promise<void>;
  onUpload: (input: {
    uri: string;
    fileName: string;
    mimeType?: string;
    alt?: string;
  }) => Promise<AssetRef>;
  onVisibleSequence: (sequence: string) => void;
  onWidgetDismiss: (messageId: string) => Promise<boolean>;
  onWidgetResponse: (messageId: string, value: string) => Promise<boolean>;
  targetMessageId?: string;
  thread: ThreadView | null;
  uploadCapabilities: ClientCapabilities["uploads"];
}) {
  const theme = useTheme();
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [replyEditVersion, setReplyEditVersion] = useState(0);
  const [composerRecovery, setComposerRecovery] = useState<ComposerRecovery | null>(null);
  const presentedRecoveryNonces = useRef(new Set<string>());
  const listRef = useRef<FlatList<ChannelMessageView>>(null);
  const atLiveEdgeRef = useRef(true);
  const placedThreadIdRef = useRef<string | null>(null);
  const targetScrollRetries = useRef(0);
  const onVisibleSequenceRef = useRef(onVisibleSequence);
  const historyViewportRef = useRef({ onVisibleMessageIds, historyHasNewer });
  historyViewportRef.current = { onVisibleMessageIds, historyHasNewer };
  const messages = useMemo(() => (thread ? [thread.root, ...thread.replies] : []), [thread]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const threadRootId = thread?.root.id ?? null;
  const timestampLabel = thread ? threadTimestamp(thread.root.createdAt) : "";
  const targetIndex = targetMessageId
    ? messages.findIndex((message) => message.id === targetMessageId)
    : -1;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<ChannelMessageView>[] }) => {
      const highest = highestVisibleSequence(
        viewableItems.map(({ isViewable, item }) => ({ isViewable, item }))
      );
      if (highest) onVisibleSequenceRef.current(highest);
      historyViewportRef.current.onVisibleMessageIds(
        viewableItems.filter(({ isViewable }) => isViewable).map(({ item }) => item.id),
        atLiveEdgeRef.current && !historyViewportRef.current.historyHasNewer
      );
    }
  ).current;

  useEffect(() => {
    onVisibleSequenceRef.current = onVisibleSequence;
  }, [onVisibleSequence]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The thread id deliberately resets local reply and scroll state when the sheet is reused for another thread.
  useEffect(() => {
    setReplyTarget(null);
    setComposerRecovery(null);
    setReplyEditVersion((current) => current + 1);
    atLiveEdgeRef.current = true;
    placedThreadIdRef.current = null;
    targetScrollRetries.current = 0;
  }, [threadRootId]);

  useEffect(() => {
    if (composerRecovery) return;
    const messageIds = new Set(messages.map((message) => message.id));
    const recovery = deliveryRecoveries.find(
      (record) =>
        Boolean(record.payload.replyToMessageId) &&
        messageIds.has(record.payload.replyToMessageId as string) &&
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
  }, [byId, composerRecovery, deliveryRecoveries, messages]);

  const recoverCancelledMessage = async (nonce: string) => {
    try {
      const payload = await onCancelQueued(nonce);
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
        clientErrorMessage(cause, "OpenTeam could not cancel this message.")
      );
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={Boolean(thread)}
    >
      <SafeAreaView
        accessibilityViewIsModal
        style={[styles.safe, { backgroundColor: theme.background }]}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
          style={styles.safe}
        >
          <View style={styles.header}>
            <IconButton
              label="Close thread"
              name="chevron.left"
              onPress={onClose}
              size={40}
              symbolSize={18}
              tone="surface"
            />
          </View>
          <FlatList
            {...MOBILE_VIRTUAL_LIST_TUNING}
            ref={listRef}
            contentContainerStyle={styles.messages}
            data={messages}
            keyExtractor={messageRenderKey}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onContentSizeChange={() => {
              if (!threadRootId) return;
              if (placedThreadIdRef.current !== threadRootId) {
                placedThreadIdRef.current = threadRootId;
                if (targetIndex >= 0) {
                  listRef.current?.scrollToIndex({
                    animated: false,
                    index: targetIndex,
                    viewPosition: 0.5,
                  });
                } else {
                  listRef.current?.scrollToEnd({ animated: false });
                }
                return;
              }
              if (atLiveEdgeRef.current) listRef.current?.scrollToEnd({ animated: true });
            }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              atLiveEdgeRef.current =
                !historyHasNewer &&
                isNearLiveEdge(contentOffset.y, layoutMeasurement.height, contentSize.height);
            }}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({
                animated: false,
                offset: Math.max(0, averageItemLength * index),
              });
              if (targetScrollRetries.current >= 2) return;
              targetScrollRetries.current += 1;
              requestAnimationFrame(() => {
                listRef.current?.scrollToIndex({
                  animated: false,
                  index,
                  viewPosition: 0.5,
                });
              });
            }}
            onViewableItemsChanged={onViewableItemsChanged}
            onEndReached={() => {
              if (historyHasNewer) void onLoadLater();
            }}
            onEndReachedThreshold={0.5}
            scrollEventThrottle={32}
            ListHeaderComponent={
              <View>
                {historyLoading ? (
                  <ActivityIndicator color={theme.textMuted} style={styles.historyAction} />
                ) : historyHasMore ? (
                  <Pressable
                    accessibilityLabel="Load earlier thread replies"
                    accessibilityRole="button"
                    onPress={() => {
                      atLiveEdgeRef.current = false;
                      void onLoadEarlier();
                    }}
                    style={({ pressed }) => [styles.historyAction, pressed && styles.pressed]}
                  >
                    <Text style={[styles.historyLabel, { color: theme.textMuted }]}>
                      Load earlier thread replies
                    </Text>
                  </Pressable>
                ) : null}
                {timestampLabel ? (
                  <Text style={[styles.timestamp, { color: theme.textFaint }]}>
                    {timestampLabel}
                  </Text>
                ) : null}
              </View>
            }
            renderItem={({ item }) => {
              const metadata = messageMetadata(item);
              const clientDelivery = clientDeliveryFor(item);
              const deliveryState = clientDelivery?.state;
              const deliveryNonce = clientDelivery?.nonce;
              const peer = metadata.fromAgent ?? metadata.toAgent;
              const peerId =
                peer && typeof peer === "object" && !Array.isArray(peer)
                  ? (peer as Record<string, unknown>).id
                  : null;
              return (
                <MessageBubble
                  animateEntrance={false}
                  assetUrl={assetUrl}
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
                    typeof clientDelivery?.composedAtMs === "number"
                      ? clientDelivery.composedAtMs
                      : null
                  }
                  deliveryQueuedAtMs={
                    typeof clientDelivery?.queuedAtMs === "number"
                      ? clientDelivery.queuedAtMs
                      : null
                  }
                  deliveryAcceptedAtMs={
                    typeof clientDelivery?.acceptedAtMs === "number"
                      ? clientDelivery.acceptedAtMs
                      : null
                  }
                  deliveryTransportDown={clientDelivery?.transportDown === true}
                  onResendFailed={(nonce) => void onResendFailed(nonce)}
                  onDeleteFailed={(nonce) => void onDeleteFailed(nonce)}
                  onCancelQueued={(nonce) => void recoverCancelledMessage(nonce)}
                  onReact={(emoji) => void onReact(item.id, emoji)}
                  onReply={() => {
                    setReplyTarget({ id: item.id, content: item.content });
                    setReplyEditVersion((current) => current + 1);
                  }}
                  onSecretSubmit={(value) => onSecretSubmit(item.id, value)}
                  onComputerHandoff={(action) => onComputerHandoff(item.id, action)}
                  onWidgetDismiss={() => onWidgetDismiss(item.id)}
                  onWidgetResponse={(value) => onWidgetResponse(item.id, value)}
                  peerBot={typeof peerId === "string" ? botById.get(peerId) : undefined}
                />
              );
            }}
          />
          {thread ? (
            <Composer
              assetUrl={assetUrl}
              botName={botName}
              draftKey={`${draftKey}:thread:${thread.root.id}`}
              mentionOptions={mentionOptions}
              placeholder={`Reply ${botName}`}
              recovery={composerRecovery}
              onRecoveryApplied={(id) => {
                setComposerRecovery((current) => (current?.id === id ? null : current));
              }}
              onRecoveryConsumed={onAcknowledgeRecovery}
              onClearReply={() => {
                setReplyTarget(null);
                setReplyEditVersion((current) => current + 1);
              }}
              onRestoreReply={setReplyTarget}
              onSend={async (content, attachments, stagedAttachments, consumedDraft) => {
                const replyTo = replyTarget?.id ?? thread.root.id;
                await onSend(content, attachments, stagedAttachments, replyTo, consumedDraft);
                setReplyTarget(null);
              }}
              onStage={stageMobileDeliveryAttachment}
              onDiscardStages={discardMobileDeliveryAttachments}
              onUpload={onUpload}
              replyEditVersion={replyEditVersion}
              replyTarget={replyTarget}
              uploadCapabilities={uploadCapabilities}
            />
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    height: 42,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  messages: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 14, paddingVertical: 10 },
  historyAction: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  historyLabel: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  timestamp: {
    alignSelf: "center",
    marginTop: 4,
    marginBottom: 14,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  },
  pressed: { opacity: 0.65 },
});
