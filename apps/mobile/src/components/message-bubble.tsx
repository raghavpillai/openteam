import type { AssetRef, BotView, ChannelMessageView } from "@openbot/contracts";
import {
  routineChangedActionLabel,
  routineChangedEventFor,
} from "@openbot/product-core/channel-events";
import { durableSendStatusLabel } from "@openbot/product-core/durable-delivery";
import {
  a2aProjectionFor,
  messageDisplayProjection,
  messageReactionPills,
  QUICK_REACTIONS,
  threadReplyCountLabel,
  withStableOccurrenceKeys,
} from "@openbot/product-core/messages";
import { formatOfflineDeliveryLabel } from "@openbot/product-core/timestamps";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Easing,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  boundedMobileAccessibilitySummary,
  messageNeedsAdvancedMobileMarkdown,
} from "../mobile-markdown-core";
import { useTheme } from "../theme";
import { AttachmentPreview } from "./attachment-preview";
import { GlassSurface } from "./glass-surface";
import { ImageViewer, type ImageViewerItem } from "./image-viewer";
import { MobileMarkdown, messageNeedsMobileMarkdown } from "./mobile-markdown";
import { MobileRichMessageCard } from "./rich-message-card";

function ReactionPill({
  emoji,
  count,
  onPress,
  readOnly,
}: {
  emoji: string;
  count: number;
  onPress: () => void;
  readOnly: boolean;
}) {
  const theme = useTheme();
  const scale = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(scale, {
      toValue: 1,
      damping: 12,
      stiffness: 280,
      mass: 0.7,
      useNativeDriver: true,
    }).start();
  }, [scale]);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityLabel={`${emoji} reaction, ${count}`}
        accessibilityRole={readOnly ? "text" : "button"}
        disabled={readOnly}
        onPress={onPress}
        style={({ pressed }) => [
          styles.reactionPill,
          { backgroundColor: theme.reaction, opacity: pressed ? 0.72 : 1 },
        ]}
      >
        <Text style={[styles.reactionEmoji, { color: theme.reactionText }]}>{emoji}</Text>
        {count > 1 ? (
          <Text style={[styles.reactionCount, { color: theme.reactionText }]}>{count}</Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export function MessageBubble({
  message,
  peerBot,
  replyPreview,
  onReply,
  onReact,
  onWidgetResponse,
  onWidgetDismiss,
  onSecretSubmit,
  onComputerHandoff,
  onOpenThread,
  onOpenRoutine,
  onStartThread,
  onMarkUnread,
  onReport,
  threadReplyCount = 0,
  threadReplyCountIsPartial = false,
  assetUrl,
  animateEntrance,
  alignRight,
  hideA2ALabel = false,
  pending,
  deliveryState,
  deliveryNonce,
  deliveryComposedAtMs,
  deliveryQueuedAtMs,
  deliveryAcceptedAtMs,
  deliveryTransportDown = false,
  onResendFailed,
  onDeleteFailed,
  onCancelQueued,
  readOnly = false,
  speakerName,
}: {
  message: ChannelMessageView;
  peerBot?: Pick<BotView, "color" | "icon" | "name">;
  replyPreview?: string | null;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onWidgetResponse: (value: string) => Promise<boolean>;
  onWidgetDismiss: () => Promise<boolean>;
  onSecretSubmit: (value: string) => Promise<boolean>;
  onComputerHandoff: (action: "start" | "skip") => Promise<boolean>;
  onOpenThread?: () => void;
  onOpenRoutine?: (routineId: string) => void;
  onStartThread?: () => void;
  onMarkUnread?: () => void;
  onReport?: () => void;
  threadReplyCount?: number;
  threadReplyCountIsPartial?: boolean;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">, download?: boolean) => string | null;
  animateEntrance: boolean;
  alignRight?: boolean;
  hideA2ALabel?: boolean;
  pending: boolean;
  deliveryState?: "pending" | "queued" | "accepted" | "failed";
  deliveryNonce?: string;
  deliveryComposedAtMs?: number | null;
  deliveryQueuedAtMs?: number | null;
  deliveryAcceptedAtMs?: number | null;
  deliveryTransportDown?: boolean;
  onResendFailed?: (nonce: string) => void;
  onDeleteFailed?: (nonce: string) => void;
  onCancelQueued?: (nonce: string) => void;
  readOnly?: boolean;
  speakerName?: string;
}) {
  const theme = useTheme();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [viewerItem, setViewerItem] = useState<ImageViewerItem | null>(null);
  const routineEvent = useMemo(() => routineChangedEventFor(message), [message]);
  const projectedA2AContext = useMemo(() => a2aProjectionFor(message), [message]);
  const a2aContext = hideA2ALabel ? null : projectedA2AContext;
  const isUser = alignRight ?? (message.sender === "user" && !projectedA2AContext);
  const [enters] = useState(animateEntrance);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const deliveryOpacity = useRef(new Animated.Value(pending ? 0.55 : 1)).current;
  const entranceOpacity = useRef(new Animated.Value(enters ? 0 : 1)).current;
  const entranceTransform = useRef(new Animated.Value(enters ? 0 : 1)).current;
  const swipeOffset = useRef(new Animated.Value(0)).current;
  const swipeThresholdReached = useRef(false);
  const reactions = useMemo(() => messageReactionPills(message), [message]);
  const display = useMemo(() => messageDisplayProjection(message), [message]);
  const { attachments, stagedAttachments, displayContent, files, images, richMessage } = display;
  const stagedImages = stagedAttachments.filter(
    (attachment) => attachment.kind === "image" && attachment.previewUri
  );
  const stagedFiles = stagedAttachments.filter(
    (attachment) => attachment.kind !== "image" || !attachment.previewUri
  );
  const attachmentCount = attachments.length + stagedAttachments.length;
  const keyedImages = useMemo(() => {
    const resolved = images.flatMap((image) => {
      const url = assetUrl(image);
      if (!url) return [];
      return [{ image, url }];
    });
    return withStableOccurrenceKeys(resolved, ({ image }) => `${image.assetId}:${image.fileName}`);
  }, [assetUrl, images]);
  const accessibilitySummary =
    (displayContent && boundedMobileAccessibilitySummary(displayContent)) ||
    `${attachmentCount} attached ${attachmentCount === 1 ? "file" : "files"}`;
  const deliveryActionsDisabled =
    pending || deliveryState === "queued" || deliveryState === "failed";
  const swipeToThreadEnabled = Boolean(onStartThread) && !readOnly && !deliveryActionsDisabled;
  const currentSentOfflineAtMs =
    deliveryState === "accepted" &&
    deliveryQueuedAtMs != null &&
    deliveryAcceptedAtMs != null &&
    deliveryComposedAtMs != null
      ? deliveryComposedAtMs
      : null;
  const [retainedSentOfflineAtMs, setRetainedSentOfflineAtMs] = useState(currentSentOfflineAtMs);
  const sentOfflineVisibility = useRef(
    new Animated.Value(currentSentOfflineAtMs === null ? 0 : 1)
  ).current;
  const displayedSentOfflineAtMs = currentSentOfflineAtMs ?? retainedSentOfflineAtMs;
  const sentOfflineLabel =
    displayedSentOfflineAtMs === null ? null : formatOfflineDeliveryLabel(displayedSentOfflineAtMs);

  useEffect(() => {
    Animated.timing(deliveryOpacity, {
      toValue: pending ? 0.55 : 1,
      duration: 120,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      useNativeDriver: true,
    }).start();
  }, [deliveryOpacity, pending]);

  useEffect(() => {
    if (currentSentOfflineAtMs !== null) {
      setRetainedSentOfflineAtMs(currentSentOfflineAtMs);
      sentOfflineVisibility.stopAnimation();
      sentOfflineVisibility.setValue(1);
      return;
    }
    if (retainedSentOfflineAtMs === null) return;
    Animated.timing(sentOfflineVisibility, {
      toValue: 0,
      duration: 200,
      easing: Easing.bezier(0.77, 0, 0.175, 1),
      useNativeDriver: false,
    }).start();
  }, [currentSentOfflineAtMs, retainedSentOfflineAtMs, sentOfflineVisibility]);

  useEffect(() => {
    if (!enters) return;
    let cancelled = false;
    let animation: Animated.CompositeAnimation | null = null;
    const start = (reduced: boolean) => {
      if (cancelled) return;
      setReduceMotion(reduced);
      const easing = Easing.bezier(0.23, 1, 0.32, 1);
      animation = reduced
        ? Animated.timing(entranceOpacity, {
            toValue: 1,
            duration: 120,
            easing,
            useNativeDriver: true,
          })
        : Animated.parallel([
            Animated.timing(entranceOpacity, {
              toValue: 1,
              duration: 132,
              easing,
              useNativeDriver: true,
            }),
            Animated.timing(entranceTransform, {
              toValue: 1,
              duration: 240,
              easing,
              useNativeDriver: true,
            }),
          ]);
      animation.start();
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(start, () => start(false));
    return () => {
      cancelled = true;
      animation?.stop();
    };
  }, [entranceOpacity, entranceTransform, enters]);

  const swipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          swipeToThreadEnabled &&
          gesture.dx > 7 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2,
        onPanResponderGrant: () => {
          swipeOffset.stopAnimation();
          swipeThresholdReached.current = false;
        },
        onPanResponderMove: (_event, gesture) => {
          const distance = Math.max(0, gesture.dx);
          const resistedDistance = Math.min(distance, 52) + Math.max(0, distance - 52) * 0.28;
          swipeOffset.setValue(Math.min(78, resistedDistance));
          const reached = distance >= 52;
          if (reached && !swipeThresholdReached.current) {
            swipeThresholdReached.current = true;
            void Haptics.selectionAsync();
          } else if (!reached && distance < 40) {
            swipeThresholdReached.current = false;
          }
        },
        onPanResponderRelease: (_event, gesture) => {
          const shouldOpen = gesture.dx >= 52 || (gesture.dx >= 24 && gesture.vx >= 0.65);
          if (shouldOpen && onStartThread) {
            if (!swipeThresholdReached.current) {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            Animated.timing(swipeOffset, {
              toValue: 78,
              duration: 72,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }).start(({ finished }) => {
              swipeOffset.setValue(0);
              swipeThresholdReached.current = false;
              if (finished) onStartThread();
            });
            return;
          }
          swipeThresholdReached.current = false;
          Animated.spring(swipeOffset, {
            toValue: 0,
            damping: 18,
            stiffness: 260,
            mass: 0.72,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminate: () => {
          swipeThresholdReached.current = false;
          Animated.spring(swipeOffset, {
            toValue: 0,
            damping: 18,
            stiffness: 260,
            mass: 0.72,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [onStartThread, swipeOffset, swipeToThreadEnabled]
  );

  const openActions = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionsOpen(true);
  };
  const renderedContent = displayContent ? (
    messageNeedsMobileMarkdown(displayContent) ? (
      <MobileMarkdown color={isUser ? theme.userText : theme.text} content={displayContent} />
    ) : (
      <Text selectable style={[styles.content, { color: isUser ? theme.userText : theme.text }]}>
        {displayContent}
      </Text>
    )
  ) : null;
  const advancedMarkdown = Boolean(
    displayContent && messageNeedsAdvancedMobileMarkdown(displayContent)
  );

  if (routineEvent) {
    const opensRoutine = Boolean(onOpenRoutine) && routineEvent.action !== "deleted";
    return (
      <Animated.View style={[styles.routineEventWrap, { opacity: deliveryOpacity }]}>
        <Pressable
          accessibilityLabel={
            opensRoutine
              ? `Open routine ${routineEvent.automationName}`
              : `${routineChangedActionLabel(routineEvent.action)} ${routineEvent.automationName}`
          }
          accessibilityRole={opensRoutine ? "button" : "text"}
          disabled={!opensRoutine}
          onPress={() => {
            void Haptics.selectionAsync();
            onOpenRoutine?.(routineEvent.automationId);
          }}
          style={({ pressed }) => [
            styles.routineEvent,
            pressed && { backgroundColor: theme.surfacePressed },
          ]}
        >
          <SymbolView
            name="clock.arrow.circlepath"
            size={13}
            tintColor={theme.textMuted}
            weight="regular"
          />
          <Text numberOfLines={2} style={[styles.routineEventText, { color: theme.textMuted }]}>
            {routineChangedActionLabel(routineEvent.action)}{" "}
            {JSON.stringify(routineEvent.automationName)}
          </Text>
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[
        styles.messageWrap,
        (richMessage || advancedMarkdown) && styles.richMessageWrap,
        isUser ? styles.alignRight : styles.alignLeft,
        { opacity: deliveryOpacity },
      ]}
    >
      {swipeToThreadEnabled ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.swipeThreadIndicator,
            isUser ? styles.swipeThreadIndicatorRight : styles.swipeThreadIndicatorLeft,
            {
              opacity: swipeOffset.interpolate({
                inputRange: [0, 20, 52],
                outputRange: [0, 0.3, 1],
                extrapolate: "clamp",
              }),
              transform: [
                {
                  scale: swipeOffset.interpolate({
                    inputRange: [0, 52],
                    outputRange: [0.72, 1],
                    extrapolate: "clamp",
                  }),
                },
              ],
            },
          ]}
        >
          <SymbolView name="arrowshape.turn.up.left" size={19} tintColor={theme.textMuted} />
        </Animated.View>
      ) : null}
      <Animated.View
        {...swipeResponder.panHandlers}
        style={[
          styles.entranceContent,
          isUser ? styles.contentRight : styles.contentLeft,
          {
            opacity: entranceOpacity,
            transform:
              reduceMotion === true
                ? [{ translateX: swipeOffset }]
                : [
                    {
                      translateY: entranceTransform.interpolate({
                        inputRange: [0, 1],
                        outputRange: [12, 0],
                      }),
                    },
                    {
                      scale: entranceTransform.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.94, 1],
                      }),
                    },
                    { translateX: swipeOffset },
                  ],
            transformOrigin: isUser ? "100% 100%" : "0% 100%",
          },
        ]}
      >
        {a2aContext ? (
          <View style={styles.a2aLabel}>
            <SymbolView name="message.fill" size={12} tintColor={theme.textMuted} />
            <Text style={[styles.a2aText, { color: theme.textMuted }]}>
              {a2aContext.direction === "incoming" ? "Message from" : "Messaged"}{" "}
              {peerBot?.name ?? a2aContext.peerName ?? "another agent"}
            </Text>
          </View>
        ) : null}
        {replyPreview ? (
          <View style={[styles.replyPreview, isUser ? styles.replyRight : styles.replyLeft]}>
            <SymbolView name="arrowshape.turn.up.left" size={13} tintColor={theme.textMuted} />
            <Text numberOfLines={1} style={[styles.replyText, { color: theme.textMuted }]}>
              {replyPreview}
            </Text>
          </View>
        ) : null}
        {richMessage ? (
          <Pressable
            accessible={false}
            delayLongPress={280}
            onLongPress={deliveryActionsDisabled ? undefined : openActions}
            style={({ pressed }) => [styles.richActionTarget, pressed && { opacity: 0.82 }]}
          >
            <MobileRichMessageCard
              message={message}
              onComputerHandoff={onComputerHandoff}
              onSecretSubmit={onSecretSubmit}
              onWidgetDismiss={onWidgetDismiss}
              onWidgetResponse={onWidgetResponse}
              readOnly={readOnly}
            />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel={`${speakerName ?? (isUser ? "You" : "Agent")}: ${accessibilitySummary}`}
            accessibilityRole="text"
            accessibilityActions={
              readOnly
                ? undefined
                : [
                    {
                      name: "showMessageActions",
                      label: "Show message actions",
                    },
                  ]
            }
            accessibilityState={{ busy: pending }}
            accessible={attachmentCount === 0}
            delayLongPress={280}
            onLongPress={deliveryActionsDisabled ? undefined : openActions}
            onAccessibilityAction={(event) => {
              if (
                event.nativeEvent.actionName === "showMessageActions" &&
                !deliveryActionsDisabled
              ) {
                openActions();
              }
            }}
            style={({ pressed }) => [
              styles.bubble,
              advancedMarkdown && styles.advancedMarkdownBubble,
              attachmentCount > 0 && styles.bubbleWithAttachments,
              attachmentCount > 0 && !displayContent && styles.attachmentOnlyBubble,
              {
                backgroundColor: isUser ? theme.userBubble : theme.assistantBubble,
                opacity: pressed ? 0.82 : 1,
              },
            ]}
          >
            {(files.length > 0 || stagedFiles.length > 0) && renderedContent ? (
              <View
                accessibilityLabel={`${speakerName ?? (isUser ? "You" : "Agent")}: ${accessibilitySummary}`}
                accessibilityRole="text"
                accessibilityState={{ busy: pending }}
                accessible
              >
                {renderedContent}
              </View>
            ) : (
              renderedContent
            )}
            {images.length > 0 || stagedImages.length > 0 ? (
              <View
                style={[
                  styles.imageGallery,
                  images.length + stagedImages.length === 1 && styles.singleImageGallery,
                ]}
              >
                {keyedImages.map(({ value: { image, url }, key }, index) => (
                  <Pressable
                    accessibilityLabel={image.alt ?? `Attached image ${index + 1}`}
                    accessibilityHint="Opens full-screen image viewer"
                    accessibilityRole="button"
                    key={key}
                    onPress={() =>
                      setViewerItem({
                        caption: image.alt?.trim() || displayContent.trim() || image.fileName,
                        uri: url,
                      })
                    }
                    style={
                      images.length + stagedImages.length === 1
                        ? [styles.singleImage, { backgroundColor: theme.surfacePressed }]
                        : [styles.gridImage, { backgroundColor: theme.surfacePressed }]
                    }
                  >
                    <Image resizeMode="cover" source={{ uri: url }} style={styles.galleryImage} />
                  </Pressable>
                ))}
                {stagedImages.map((image, index) => (
                  <Pressable
                    accessibilityLabel={image.alt ?? `Attached image ${images.length + index + 1}`}
                    accessibilityHint="Opens full-screen image viewer"
                    accessibilityRole="button"
                    key={image.stagingId}
                    onPress={() =>
                      setViewerItem({
                        caption: image.alt?.trim() || displayContent.trim() || image.fileName,
                        uri: image.previewUri ?? "",
                      })
                    }
                    style={
                      images.length + stagedImages.length === 1
                        ? [styles.singleImage, { backgroundColor: theme.surfacePressed }]
                        : [styles.gridImage, { backgroundColor: theme.surfacePressed }]
                    }
                  >
                    <Image
                      resizeMode="cover"
                      source={{ uri: image.previewUri }}
                      style={styles.galleryImage}
                    />
                  </Pressable>
                ))}
              </View>
            ) : null}
            {files.length > 0 || stagedFiles.length > 0 ? (
              <View style={styles.fileList}>
                {files.map((file) => (
                  <AttachmentPreview
                    asset={file}
                    key={`${file.assetId}:${file.fileName}`}
                    url={assetUrl(file, true)}
                  />
                ))}
                {stagedFiles.map((file) => (
                  <View
                    key={file.stagingId}
                    style={[
                      styles.stagedFile,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <SymbolView name="doc.fill" size={18} tintColor={theme.textMuted} />
                    <Text
                      numberOfLines={1}
                      style={[styles.stagedFileName, { color: theme.textMuted }]}
                    >
                      {file.fileName}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </Pressable>
        )}
        {reactions.length > 0 ? (
          <View style={[styles.reactions, isUser ? styles.reactionsRight : styles.reactionsLeft]}>
            {reactions.map((reaction) => (
              <ReactionPill
                key={reaction.emoji}
                {...reaction}
                onPress={() => onReact(reaction.emoji)}
                readOnly={readOnly}
              />
            ))}
          </View>
        ) : null}
        {threadReplyCount > 0 && onOpenThread ? (
          <Pressable
            accessibilityLabel={`Open thread with ${threadReplyCountLabel(threadReplyCount, threadReplyCountIsPartial)}`}
            accessibilityRole="button"
            hitSlop={6}
            onPress={onOpenThread}
            style={({ pressed }) => [styles.threadButton, { opacity: pressed ? 0.62 : 1 }]}
          >
            <SymbolView name="bubble.left.and.bubble.right" size={13} tintColor={theme.accent} />
            <Text style={[styles.threadLabel, { color: theme.accent }]}>
              {threadReplyCountLabel(threadReplyCount, threadReplyCountIsPartial)}
            </Text>
          </Pressable>
        ) : null}
        {deliveryState === "queued" && deliveryNonce ? (
          <View
            accessibilityLabel="Queued message actions"
            style={[styles.deliveryFooter, isUser ? styles.deliveryFooterRight : null]}
          >
            <Text style={[styles.deliveryStatus, { color: theme.textMuted }]}>
              {durableSendStatusLabel("queued", deliveryTransportDown)}
            </Text>
            {onCancelQueued ? (
              <Pressable
                accessibilityLabel="Cancel queued message"
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => onCancelQueued(deliveryNonce)}
                style={({ pressed }) => [styles.deliveryAction, { opacity: pressed ? 0.55 : 1 }]}
              >
                <Text style={[styles.deliveryActionText, { color: theme.textMuted }]}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>
        ) : deliveryState === "failed" && deliveryNonce ? (
          <View
            accessibilityLabel="Failed message actions"
            style={[styles.deliveryFooter, isUser ? styles.deliveryFooterRight : null]}
          >
            <Text style={[styles.deliveryStatus, { color: theme.danger }]}>
              {durableSendStatusLabel("failed")}
            </Text>
            {onResendFailed ? (
              <Pressable
                accessibilityLabel="Resend failed message"
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => onResendFailed(deliveryNonce)}
                style={({ pressed }) => [styles.deliveryAction, { opacity: pressed ? 0.55 : 1 }]}
              >
                <Text style={[styles.deliveryActionText, { color: theme.accent }]}>Resend</Text>
              </Pressable>
            ) : null}
            {onDeleteFailed ? (
              <Pressable
                accessibilityLabel="Delete failed message"
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => onDeleteFailed(deliveryNonce)}
                style={({ pressed }) => [styles.deliveryAction, { opacity: pressed ? 0.55 : 1 }]}
              >
                <Text style={[styles.deliveryActionText, { color: theme.textMuted }]}>Delete</Text>
              </Pressable>
            ) : null}
          </View>
        ) : sentOfflineLabel ? (
          <Animated.Text
            accessibilityElementsHidden={currentSentOfflineAtMs === null}
            importantForAccessibility={
              currentSentOfflineAtMs === null ? "no-hide-descendants" : "auto"
            }
            style={[
              styles.sentOffline,
              isUser ? styles.sentOfflineRight : null,
              { color: theme.textMuted },
              {
                maxHeight: sentOfflineVisibility.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 32],
                }),
                marginTop: sentOfflineVisibility.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 4],
                }),
                opacity: sentOfflineVisibility,
              },
            ]}
          >
            {sentOfflineLabel}
          </Animated.Text>
        ) : null}
      </Animated.View>

      <ImageViewer item={viewerItem} onClose={() => setViewerItem(null)} />

      {actionsOpen ? (
        <Modal
          animationType="fade"
          transparent
          visible
          onRequestClose={() => setActionsOpen(false)}
        >
          <Pressable style={styles.overlay} onPress={() => setActionsOpen(false)}>
            <View
              style={[
                styles.actionAnchor,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.border,
                },
              ]}
            >
              {!readOnly ? (
                <View style={styles.reactionPanel}>
                  <View style={styles.emojiRow}>
                    {QUICK_REACTIONS.map((emoji) => (
                      <Pressable
                        accessibilityLabel={`React ${emoji}`}
                        accessibilityRole="button"
                        key={emoji}
                        onPress={() => {
                          setActionsOpen(false);
                          onReact(emoji);
                        }}
                        style={({ pressed }) => [
                          styles.emojiAction,
                          pressed && { backgroundColor: theme.surfacePressed },
                        ]}
                      >
                        <Text style={styles.emojiActionText}>{emoji}</Text>
                      </Pressable>
                    ))}
                    <Pressable
                      accessibilityLabel="More reactions"
                      accessibilityRole="button"
                      onPress={() => {
                        setActionsOpen(false);
                        Alert.alert(
                          "More reactions",
                          "Custom emoji reactions are not available on this server."
                        );
                      }}
                      style={({ pressed }) => [
                        styles.emojiAction,
                        pressed && { backgroundColor: theme.surfacePressed },
                      ]}
                    >
                      <View>
                        <SymbolView name="face.smiling" size={25} tintColor={theme.textMuted} />
                        <View
                          style={[styles.reactionPlus, { backgroundColor: theme.surfaceElevated }]}
                        >
                          <SymbolView name="plus" size={8} tintColor={theme.textMuted} />
                        </View>
                      </View>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {!readOnly ? (
                <View
                  style={[styles.actionPanel, { backgroundColor: theme.surfaceElevated }]}
                >
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setActionsOpen(false);
                      onReply();
                    }}
                    style={({ pressed }) => [
                      styles.menuRow,
                      pressed && { backgroundColor: theme.surfacePressed },
                    ]}
                  >
                    <SymbolView name="arrowshape.turn.up.left" size={19} tintColor={theme.text} />
                    <Text style={[styles.menuLabel, { color: theme.text }]}>Reply</Text>
                  </Pressable>
                  {onStartThread ? (
                    <>
                      <View style={[styles.divider, { backgroundColor: theme.separator }]} />
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          setActionsOpen(false);
                          onStartThread();
                        }}
                        style={({ pressed }) => [
                          styles.menuRow,
                          pressed && { backgroundColor: theme.surfacePressed },
                        ]}
                      >
                        <SymbolView
                          name="bubble.left.and.bubble.right"
                          size={19}
                          tintColor={theme.text}
                        />
                        <Text style={[styles.menuLabel, { color: theme.text }]}>
                          Start a thread
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                  {onMarkUnread ? (
                    <>
                      <View style={[styles.divider, { backgroundColor: theme.separator }]} />
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          setActionsOpen(false);
                          onMarkUnread();
                        }}
                        style={({ pressed }) => [
                          styles.menuRow,
                          pressed && { backgroundColor: theme.surfacePressed },
                        ]}
                      >
                        <SymbolView name="bubble.left" size={19} tintColor={theme.text} />
                        <Text style={[styles.menuLabel, { color: theme.text }]}>
                          Mark as unread
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              ) : null}
              <View style={[styles.actionPanel, { backgroundColor: theme.surfaceElevated }]}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setActionsOpen(false);
                    void Clipboard.setStringAsync(message.content);
                  }}
                  style={({ pressed }) => [
                    styles.menuRow,
                    pressed && { backgroundColor: theme.surfacePressed },
                  ]}
                >
                  <SymbolView name="doc.on.doc" size={18} tintColor={theme.text} />
                  <Text style={[styles.menuLabel, { color: theme.text }]}>Copy</Text>
                </Pressable>
              </View>
              {!readOnly && onReport ? (
                <View style={[styles.actionPanel, { backgroundColor: theme.surfaceElevated }]}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setActionsOpen(false);
                      onReport();
                    }}
                    style={({ pressed }) => [
                      styles.menuRow,
                      pressed && { backgroundColor: theme.surfacePressed },
                    ]}
                  >
                    <SymbolView name="flag" size={19} tintColor={theme.text} />
                    <Text style={[styles.menuLabel, { color: theme.text }]}>Report</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  routineEventWrap: { alignSelf: "stretch", alignItems: "center", marginVertical: 3 },
  routineEvent: {
    minHeight: 30,
    maxWidth: "94%",
    borderRadius: 15,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  routineEventText: { flexShrink: 1, fontSize: 12, lineHeight: 18, fontWeight: "400" },
  messageWrap: { maxWidth: "89%", marginVertical: 3 },
  // Rich cards contain percentage-width children. Give their wrapping message an
  // explicit width so Yoga does not resolve the circular percentage against the
  // card's min-content width (which can collapse short widget labels vertically).
  richMessageWrap: { width: "88%" },
  entranceContent: { maxWidth: "100%" },
  contentLeft: { alignItems: "flex-start" },
  contentRight: { alignItems: "flex-end" },
  alignLeft: { alignSelf: "flex-start" },
  alignRight: { alignSelf: "flex-end" },
  swipeThreadIndicator: {
    position: "absolute",
    top: "50%",
    width: 24,
    height: 24,
    marginTop: -12,
    alignItems: "center",
    justifyContent: "center",
  },
  swipeThreadIndicatorLeft: { left: 17 },
  swipeThreadIndicatorRight: { left: -31 },
  bubble: { borderRadius: 21, paddingHorizontal: 15, paddingVertical: 10 },
  advancedMarkdownBubble: { width: "100%" },
  richActionTarget: { width: "100%", maxWidth: 520 },
  bubbleWithAttachments: { paddingHorizontal: 6, paddingBottom: 6 },
  attachmentOnlyBubble: { paddingTop: 6 },
  content: { fontSize: 16, lineHeight: 22, letterSpacing: -0.15 },
  imageGallery: {
    width: 228,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 7,
  },
  singleImageGallery: { width: 246 },
  singleImage: {
    width: 246,
    height: 184,
    borderRadius: 16,
    overflow: "hidden",
  },
  gridImage: {
    width: 112,
    height: 104,
    borderRadius: 14,
    overflow: "hidden",
  },
  galleryImage: { width: "100%", height: "100%" },
  fileList: { alignSelf: "flex-start", gap: 7, marginTop: 7 },
  stagedFile: {
    width: 246,
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 13,
    paddingHorizontal: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  stagedFileName: { flex: 1, fontSize: 13, lineHeight: 17, fontWeight: "500" },
  a2aLabel: {
    minHeight: 24,
    paddingHorizontal: 5,
    paddingTop: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  a2aText: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  replyPreview: {
    maxWidth: "94%",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 4,
    paddingHorizontal: 8,
  },
  replyLeft: { alignSelf: "flex-start" },
  replyRight: { alignSelf: "flex-end" },
  replyText: { maxWidth: 230, fontSize: 12, lineHeight: 16 },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: -4 },
  reactionsLeft: { marginLeft: 12 },
  reactionsRight: { alignSelf: "flex-end", marginRight: 12 },
  reactionPill: {
    minWidth: 30,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  reactionEmoji: { fontSize: 14, lineHeight: 18 },
  reactionCount: { fontSize: 11, lineHeight: 14, fontWeight: "700" },
  threadButton: {
    minHeight: 32,
    alignSelf: "flex-start",
    marginLeft: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  threadLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  deliveryFooter: {
    minHeight: 28,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  deliveryFooterRight: { alignSelf: "flex-end" },
  deliveryStatus: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  deliveryAction: { minHeight: 28, justifyContent: "center" },
  deliveryActionText: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  sentOffline: {
    overflow: "hidden",
    paddingHorizontal: 8,
    fontSize: 11,
    lineHeight: 15,
  },
  sentOfflineRight: { alignSelf: "flex-end" },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.50)",
    justifyContent: "flex-end",
    paddingHorizontal: 8,
    paddingBottom: 5,
  },
  actionAnchor: {
    width: "100%",
    gap: 10,
    paddingHorizontal: 13,
    paddingTop: 14,
    paddingBottom: 10,
    borderRadius: 26,
    overflow: "hidden",
  },
  actionPanel: {
    width: "100%",
    borderRadius: 18,
    overflow: "hidden",
  },
  reactionPanel: {
    width: "100%",
    height: 60,
    justifyContent: "center",
  },
  emojiRow: { flexDirection: "row", justifyContent: "space-between" },
  emojiAction: {
    width: 44,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiActionText: { fontSize: 22 },
  reactionPlus: {
    position: "absolute",
    right: -5,
    bottom: -4,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  menuRow: {
    height: 44,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  menuLabel: { fontSize: 16, lineHeight: 21, fontWeight: "400" },
});
