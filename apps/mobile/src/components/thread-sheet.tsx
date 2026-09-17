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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { highestVisibleSequence } from "../chat-viewport";
import { ChatChromeFade } from "./chat-chrome-fade";
import { useChatKeyboard } from "../hooks/use-chat-keyboard";
import { useMessageFocus } from "../hooks/use-message-focus";
import { useChatScroll } from "../hooks/use-chat-scroll";
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
  transcriptionConfigured,
  onTranscribe,
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
  transcriptionConfigured: boolean;
  onTranscribe: (uri: string, signal: AbortSignal) => Promise<{ text: string }>;
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
  const insets = useSafeAreaInsets();
  const keyboardVisible = useChatKeyboard();
  const [composerHeight, setComposerHeight] = useState(80);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [replyEditVersion, setReplyEditVersion] = useState(0);
  const [composerRecovery, setComposerRecovery] = useState<ComposerRecovery | null>(null);
  const presentedRecoveryNonces = useRef(new Set<string>());
  const listRef = useRef<FlatList<ChannelMessageView>>(null);
  const atLiveEdgeRef = useRef(true);
  const onVisibleSequenceRef = useRef(onVisibleSequence);
  const visibleMessageIds = useRef<readonly string[]>([]);
  const historyViewportRef = useRef({ onVisibleMessageIds, historyHasNewer });
  historyViewportRef.current = { onVisibleMessageIds, historyHasNewer };
  const chatScroll = useChatScroll(
    listRef,
    (next) => {
      atLiveEdgeRef.current = next;
      historyViewportRef.current.onVisibleMessageIds(
        visibleMessageIds.current,
        next && !historyViewportRef.current.historyHasNewer
      );
    },
    historyHasNewer
  );
  const { reset: resetScroll, setFollowing, correctAfterLayout } = chatScroll;
  const messages = useMemo(() => (thread ? [thread.root, ...thread.replies] : []), [thread]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const threadRootId = thread?.root.id ?? null;
  const timestampLabel = thread ? threadTimestamp(thread.root.createdAt) : "";
  const targetIndex = targetMessageId
    ? messages.findIndex((message) => message.id === targetMessageId)
    : -1;
  const messageFocus = useMessageFocus(listRef, targetMessageId, targetIndex);
  const focusVisibleIds = messageFocus.onVisibleMessageIds;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<ChannelMessageView>[] }) => {
      const highest = highestVisibleSequence(
        viewableItems.map(({ isViewable, item }) => ({ isViewable, item }))
      );
      if (highest) onVisibleSequenceRef.current(highest);
      visibleMessageIds.current = viewableItems
        .filter(({ isViewable }) => isViewable)
        .map(({ item }) => item.id);
      focusVisibleIds(visibleMessageIds.current);
      historyViewportRef.current.onVisibleMessageIds(
        visibleMessageIds.current,
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
    visibleMessageIds.current = [];
    resetScroll(!targetMessageId);
  }, [threadRootId, targetMessageId, resetScroll]);

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
      message: recovery.failure?.message,
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
      <View accessibilityViewIsModal style={[styles.safe, { backgroundColor: theme.background }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
          style={styles.safe}
        >
          <View style={styles.safe}>
            <ChatChromeFade
              edge="top"
              style={{ bottom: undefined, height: insets.top + 104, zIndex: 2 }}
            />
            <View style={[styles.header, { top: insets.top + 6 }]}>
              <IconButton
                label="Close thread"
                name="chevron.left"
                onPress={onClose}
                size={44}
                symbolSize={18}
                symbolWeight="regular"
                symbolOffsetX={1}
                tone="glass"
              />
            </View>
            <FlatList
              {...MOBILE_VIRTUAL_LIST_TUNING}
              ref={listRef}
              contentContainerStyle={[
                styles.messages,
                { paddingTop: insets.top + 66, paddingBottom: composerHeight + 15 },
              ]}
              data={messages}
              keyExtractor={messageRenderKey}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              maintainVisibleContentPosition={
                chatScroll.following ? undefined : { minIndexForVisible: 0 }
              }
              onLayout={chatScroll.onLayout}
              onContentSizeChange={chatScroll.onContentSizeChange}
              onScroll={chatScroll.onScroll}
              onScrollBeginDrag={() => {
                messageFocus.cancel();
                chatScroll.onScrollBeginDrag();
              }}
              onScrollEndDrag={chatScroll.onScrollEndDrag}
              onMomentumScrollBegin={chatScroll.onMomentumScrollBegin}
              onMomentumScrollEnd={chatScroll.onMomentumScrollEnd}
              onScrollToIndexFailed={messageFocus.onScrollToIndexFailed}
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
                        setFollowing(false);
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
              <View
                onLayout={(event) => setComposerHeight(Math.ceil(event.nativeEvent.layout.height))}
                style={[
                  styles.composerOverlay,
                  { paddingBottom: keyboardVisible ? 18 : Math.max(12, insets.bottom - 4) },
                ]}
              >
                <ChatChromeFade edge="bottom" />
                <Composer
                  keyboardVisible={keyboardVisible}
                  transcriptionConfigured={transcriptionConfigured}
                  onTranscribe={onTranscribe}
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
                    messageFocus.cancel();
                    setFollowing(true);
                    await onSend(content, attachments, stagedAttachments, replyTo, consumedDraft);
                    setReplyTarget(null);
                    if (historyHasNewer) await onLoadLater();
                    correctAfterLayout();
                  }}
                  onStage={stageMobileDeliveryAttachment}
                  onDiscardStages={discardMobileDeliveryAttachments}
                  onUpload={onUpload}
                  replyEditVersion={replyEditVersion}
                  replyTarget={replyTarget}
                  uploadCapabilities={uploadCapabilities}
                />
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  composerOverlay: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 3 },
  header: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 3,
    minHeight: 44,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
  },
  messages: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 16 },
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
