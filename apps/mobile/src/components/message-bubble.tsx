import type { AssetKind, AssetRef, BotView, ChannelMessageView } from "@openbot/contracts";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../theme";
import { GlassSurface } from "./glass-surface";

const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"];

const metadataFor = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const reactionPills = (message: ChannelMessageView): Array<{ emoji: string; count: number }> => {
  const reactions = metadataFor(message).reactions;
  if (!Array.isArray(reactions)) return [];
  const counts = new Map<string, number>();
  for (const item of reactions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const emoji = (item as Record<string, unknown>).emoji;
    if (typeof emoji === "string") counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  return [...counts].map(([emoji, count]) => ({ emoji, count }));
};

const ASSET_ID = /^[a-f0-9]{64}$/;
const ASSET_KINDS = new Set<AssetKind>(["image", "video", "audio", "pdf", "text", "file"]);

const parsedAsset = (candidate: unknown): AssetRef | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const { assetId, fileName, mimeType, byteSize, kind, width, height, alt } = candidate as Record<
    string,
    unknown
  >;
  if (
    typeof assetId !== "string" ||
    !ASSET_ID.test(assetId) ||
    typeof fileName !== "string" ||
    !fileName ||
    typeof mimeType !== "string" ||
    typeof byteSize !== "number" ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 1 ||
    typeof kind !== "string" ||
    !ASSET_KINDS.has(kind as AssetKind)
  ) {
    return null;
  }
  return {
    assetId,
    fileName,
    mimeType,
    byteSize,
    kind: kind as AssetKind,
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
    ...(typeof alt === "string" ? { alt } : {}),
  };
};

const messageAssets = (message: ChannelMessageView): AssetRef[] => {
  const metadata = metadataFor(message);
  const candidates = [
    ...(Array.isArray(metadata.attachments) ? metadata.attachments : []),
    ...(metadata.attachment ? [metadata.attachment] : []),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const asset = parsedAsset(candidate);
    if (!asset) return [];
    const key = `${asset.assetId}:${asset.fileName}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [asset];
  });
};

const readableSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const fileSymbol = (kind: AssetKind) => {
  if (kind === "pdf") return "doc.richtext.fill" as const;
  if (kind === "audio") return "waveform" as const;
  if (kind === "video") return "film.fill" as const;
  if (kind === "text") return "doc.text.fill" as const;
  return "doc.fill" as const;
};

const a2aContextFor = (message: ChannelMessageView) => {
  const metadata = metadataFor(message);
  const direction = metadata.fromAgent ? "incoming" : metadata.toAgent ? "outgoing" : null;
  if (!direction) return null;
  const candidate = direction === "incoming" ? metadata.fromAgent : metadata.toAgent;
  const peer =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : null;
  return {
    direction,
    peerId: typeof peer?.id === "string" ? peer.id : null,
    peerName: typeof peer?.name === "string" ? peer.name : null,
  } as const;
};

function ReactionPill({
  emoji,
  count,
  onPress,
}: {
  emoji: string;
  count: number;
  onPress: () => void;
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
        accessibilityRole="button"
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
  assetUrl,
  animateEntrance,
  pending,
}: {
  message: ChannelMessageView;
  peerBot?: Pick<BotView, "color" | "icon" | "name">;
  replyPreview?: string | null;
  onReply: () => void;
  onReact: (emoji: string) => void;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">, download?: boolean) => string | null;
  animateEntrance: boolean;
  pending: boolean;
}) {
  const theme = useTheme();
  const [actionsOpen, setActionsOpen] = useState(false);
  const a2aContext = useMemo(() => a2aContextFor(message), [message]);
  const isUser = message.sender === "user" && !a2aContext;
  const [enters] = useState(animateEntrance);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const deliveryOpacity = useRef(new Animated.Value(pending ? 0.55 : 1)).current;
  const entranceOpacity = useRef(new Animated.Value(enters ? 0 : 1)).current;
  const entranceTransform = useRef(new Animated.Value(enters ? 0 : 1)).current;
  const reactions = useMemo(() => reactionPills(message), [message]);
  const attachments = useMemo(() => messageAssets(message), [message]);
  const images = useMemo(
    () => attachments.filter((attachment) => attachment.kind === "image"),
    [attachments]
  );
  const files = useMemo(
    () => attachments.filter((attachment) => attachment.kind !== "image"),
    [attachments]
  );
  const keyedImages = useMemo(() => {
    const occurrences = new Map<string, number>();
    return images.flatMap((image) => {
      const url = assetUrl(image);
      if (!url) return [];
      const fingerprint = `${image.assetId}:${image.fileName}`;
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      return [{ image, url, key: `${fingerprint}:${occurrence}` }];
    });
  }, [assetUrl, images]);
  const attachmentOnly =
    Boolean(metadataFor(message).attachment) &&
    attachments.length === 1 &&
    message.content === attachments[0]?.fileName;
  const displayContent = attachmentOnly ? "" : message.content;
  const accessibilitySummary =
    displayContent ||
    `${attachments.length} attached ${attachments.length === 1 ? "file" : "files"}`;

  useEffect(() => {
    Animated.timing(deliveryOpacity, {
      toValue: pending ? 0.55 : 1,
      duration: 120,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      useNativeDriver: true,
    }).start();
  }, [deliveryOpacity, pending]);

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

  const openActions = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionsOpen(true);
  };

  return (
    <Animated.View
      style={[
        styles.messageWrap,
        isUser ? styles.alignRight : styles.alignLeft,
        { opacity: deliveryOpacity },
      ]}
    >
      <Animated.View
        style={[
          styles.entranceContent,
          isUser ? styles.contentRight : styles.contentLeft,
          {
            opacity: entranceOpacity,
            transform:
              reduceMotion === true
                ? []
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
        <Pressable
          accessibilityLabel={`${isUser ? "You" : "Agent"}: ${accessibilitySummary}`}
          accessibilityRole="text"
          accessibilityState={{ busy: pending }}
          delayLongPress={280}
          onLongPress={pending ? undefined : openActions}
          style={({ pressed }) => [
            styles.bubble,
            attachments.length > 0 && styles.bubbleWithAttachments,
            attachments.length > 0 && !displayContent && styles.attachmentOnlyBubble,
            {
              backgroundColor: isUser ? theme.userBubble : theme.assistantBubble,
              opacity: pressed ? 0.82 : 1,
            },
          ]}
        >
          {displayContent ? (
            <Text
              selectable
              style={[styles.content, { color: isUser ? theme.userText : theme.text }]}
            >
              {displayContent}
            </Text>
          ) : null}
          {images.length > 0 ? (
            <View style={[styles.imageGallery, images.length === 1 && styles.singleImageGallery]}>
              {keyedImages.map(({ image, url, key }, index) => (
                <Image
                  accessibilityLabel={image.alt ?? `Attached image ${index + 1}`}
                  accessible
                  key={key}
                  resizeMode="cover"
                  source={{ uri: url }}
                  style={images.length === 1 ? styles.singleImage : styles.gridImage}
                />
              ))}
            </View>
          ) : null}
          {files.length > 0 ? (
            <View style={styles.fileList}>
              {files.map((file) => (
                <Pressable
                  accessibilityLabel={`Open ${file.fileName}`}
                  accessibilityRole="link"
                  key={`${file.assetId}:${file.fileName}`}
                  onPress={() => {
                    const url = assetUrl(file, true);
                    if (url) void Linking.openURL(url);
                  }}
                  style={({ pressed }) => [
                    styles.fileCard,
                    {
                      backgroundColor: theme.surface,
                      borderColor: theme.border,
                      opacity: pressed ? 0.74 : 1,
                    },
                  ]}
                >
                  <View style={[styles.fileIcon, { backgroundColor: theme.surfacePressed }]}>
                    <SymbolView
                      name={fileSymbol(file.kind)}
                      size={19}
                      tintColor={theme.textMuted}
                    />
                  </View>
                  <View style={styles.fileCopy}>
                    <Text numberOfLines={1} style={[styles.fileTitle, { color: theme.text }]}>
                      {file.fileName}
                    </Text>
                    <Text style={[styles.fileMeta, { color: theme.textMuted }]}>
                      {readableSize(file.byteSize)}
                    </Text>
                  </View>
                  <SymbolView name="arrow.down.circle" size={18} tintColor={theme.textMuted} />
                </Pressable>
              ))}
            </View>
          ) : null}
        </Pressable>
        {reactions.length > 0 ? (
          <View style={[styles.reactions, isUser ? styles.reactionsRight : styles.reactionsLeft]}>
            {reactions.map((reaction) => (
              <ReactionPill
                key={reaction.emoji}
                {...reaction}
                onPress={() => onReact(reaction.emoji)}
              />
            ))}
          </View>
        ) : null}
      </Animated.View>

      <Modal
        animationType="fade"
        transparent
        visible={actionsOpen}
        onRequestClose={() => setActionsOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setActionsOpen(false)}>
          <View style={[styles.actionAnchor, isUser ? styles.actionRight : styles.actionLeft]}>
            <GlassSurface
              fallbackColor={theme.surfaceElevated}
              style={[styles.actionPanel, { borderColor: theme.border }]}
            >
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
              </View>
              <View style={[styles.divider, { backgroundColor: theme.separator }]} />
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
            </GlassSurface>
          </View>
        </Pressable>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  messageWrap: { maxWidth: "88%", marginVertical: 3 },
  entranceContent: { maxWidth: "100%" },
  contentLeft: { alignItems: "flex-start" },
  contentRight: { alignItems: "flex-end" },
  alignLeft: { alignSelf: "flex-start" },
  alignRight: { alignSelf: "flex-end" },
  bubble: { borderRadius: 21, paddingHorizontal: 15, paddingVertical: 10 },
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
  singleImage: { width: 246, height: 184, borderRadius: 16, backgroundColor: "#D6D6D2" },
  gridImage: { width: 112, height: 104, borderRadius: 14, backgroundColor: "#D6D6D2" },
  fileList: { width: 246, gap: 5, marginTop: 7 },
  fileCard: {
    minHeight: 54,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  fileIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  fileCopy: { flex: 1, minWidth: 0 },
  fileTitle: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  fileMeta: { fontSize: 11, lineHeight: 14 },
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
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.20)",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  actionAnchor: { width: "100%" },
  actionLeft: { alignItems: "flex-start" },
  actionRight: { alignItems: "flex-end" },
  actionPanel: {
    width: 338,
    maxWidth: "100%",
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 8,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  emojiRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  emojiAction: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiActionText: { fontSize: 27 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 5 },
  menuRow: {
    height: 48,
    borderRadius: 14,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  menuLabel: { fontSize: 17, lineHeight: 22, fontWeight: "500" },
});
