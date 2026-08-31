import type { ChannelMessageView } from "@openbot/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApprovalCard } from "../../src/components/approval-card";
import { BotMark } from "../../src/components/bot-mark";
import { Composer, type ReplyTarget } from "../../src/components/composer";
import { GlassSurface } from "../../src/components/glass-surface";
import { IconButton } from "../../src/components/icon-button";
import { MessageBubble } from "../../src/components/message-bubble";
import { WorkingIndicator } from "../../src/components/working-indicator";
import { setActiveNotificationChannel } from "../../src/notifications";
import { useOpenBot } from "../../src/state/openbot-context";
import { useTheme } from "../../src/theme";

const metadataFor = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const clientDeliveryFor = (message: ChannelMessageView) => {
  const candidate = metadataFor(message).clientDelivery;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
};

const messageRenderKey = (message: ChannelMessageView) => {
  const renderKey = clientDeliveryFor(message)?.renderKey;
  return typeof renderKey === "string" ? renderKey : message.id;
};

export default function ConversationScreen() {
  const theme = useTheme();
  const { channelId, messageId } = useLocalSearchParams<{
    channelId: string;
    messageId?: string;
  }>();
  const {
    snapshot,
    sendMessage,
    uploadAsset,
    assetUrl,
    reactToMessage,
    resolveApproval,
    markChannelRead,
  } = useOpenBot();
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const listRef = useRef<FlatList<ChannelMessageView>>(null);
  const didPlaceInitialScroll = useRef(false);
  const targetScrollRetries = useRef(0);
  const knownMessageKeys = useRef<Set<string> | null>(null);
  const knownChannelId = useRef(channelId);
  const channel = snapshot.channels.find((candidate) => candidate.id === channelId);
  const botId = channel?.members[0]?.botId;
  const bot = snapshot.bots.find((candidate) => candidate.id === botId);
  const messages = useMemo(
    () => snapshot.channelMessages.filter((message) => message.channelId === channelId),
    [channelId, snapshot.channelMessages]
  );
  const enteringMessageKeys = useMemo(() => {
    const known = knownChannelId.current === channelId ? knownMessageKeys.current : null;
    if (!known) return new Set<string>();
    return new Set(
      messages.map(messageRenderKey).filter((messageKey) => !known.has(messageKey))
    );
  }, [channelId, messages]);
  useEffect(() => {
    knownChannelId.current = channelId;
    knownMessageKeys.current = new Set(messages.map(messageRenderKey));
  }, [channelId, messages]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const targetIndex = messageId ? messages.findIndex((message) => message.id === messageId) : -1;
  const activeRun = snapshot.runs.find(
    (run) =>
      run.channelId === channelId && ["queued", "running", "waiting_approval"].includes(run.status)
  );
  const approvals = activeRun
    ? snapshot.approvals.filter(
        (approval) => approval.runId === activeRun.id && approval.status === "pending"
      )
    : [];
  const name = bot?.name ?? channel?.name ?? "OpenBot";

  useEffect(() => {
    didPlaceInitialScroll.current = false;
    targetScrollRetries.current = 0;
    if (targetIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({
        index: targetIndex,
        animated: false,
        viewPosition: 0.5,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [messageId, targetIndex]);

  useEffect(() => {
    setActiveNotificationChannel(channelId);
    return () => setActiveNotificationChannel(null);
  }, [channelId]);

  useEffect(() => {
    void markChannelRead(channelId);
  }, [channelId, markChannelRead, messages.at(-1)?.sequence]);

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
          <GlassSurface
            fallbackColor={theme.surfaceElevated}
            accessibilityLabel={`${name} conversation details`}
            accessibilityRole="button"
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
          <IconButton
            label="Open shared computer"
            name="desktopcomputer"
            onPress={() => {
              if (!botId) return;
              router.push({ pathname: "/computer/[botId]", params: { botId } });
            }}
            size={38}
            symbolSize={18}
            tone="surface"
          />
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={messageRenderKey}
          contentContainerStyle={styles.messages}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            if (!didPlaceInitialScroll.current && targetIndex >= 0) {
              didPlaceInitialScroll.current = true;
              listRef.current?.scrollToIndex({
                index: targetIndex,
                animated: false,
                viewPosition: 0.5,
              });
              return;
            }
            if (!messageId) listRef.current?.scrollToEnd({ animated: false });
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
          renderItem={({ item }) => {
            const metadata = metadataFor(item);
            const replyId = metadata.replyTo;
            const replyPreview = typeof replyId === "string" ? byId.get(replyId)?.content : null;
            const peer = metadata.fromAgent ?? metadata.toAgent;
            const peerId =
              peer && typeof peer === "object" && !Array.isArray(peer)
                ? (peer as Record<string, unknown>).id
                : null;
            const peerBot =
              typeof peerId === "string"
                ? snapshot.bots.find((candidate) => candidate.id === peerId)
                : undefined;
            const deliveryState = clientDeliveryFor(item)?.state;
            const renderKey = messageRenderKey(item);
            return (
              <MessageBubble
                animateEntrance={enteringMessageKeys.has(renderKey)}
                message={item}
                pending={deliveryState === "pending"}
                peerBot={peerBot}
                replyPreview={replyPreview}
                assetUrl={assetUrl}
                onReply={() => setReplyTarget({ id: item.id, content: item.content })}
                onReact={(emoji) => void reactToMessage(item.id, emoji)}
              />
            );
          }}
          ListFooterComponent={
            <View>
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onResolve={(decision) => void resolveApproval(approval.id, decision)}
                />
              ))}
              {activeRun && approvals.length === 0 ? <WorkingIndicator name={name} /> : null}
            </View>
          }
        />

        <Composer
          botName={name}
          replyTarget={replyTarget}
          onClearReply={() => setReplyTarget(null)}
          assetUrl={assetUrl}
          onUpload={uploadAsset}
          onSend={async (content, attachments) => {
            await sendMessage(channelId, content, attachments, replyTarget?.id);
            setReplyTarget(null);
          }}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
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
  title: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  messages: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
  },
});
