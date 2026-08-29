import type { InlineImageInput } from "@openbot/contracts";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  Image,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { metrics, useTheme } from "../theme";
import { GlassSurface } from "./glass-surface";
import { IconButton } from "./icon-button";

export interface ReplyTarget {
  id: string;
  content: string;
}

interface PendingImage extends InlineImageInput {
  id: string;
}

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DOCUMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const attachmentId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const normalizedDocumentMime = (mimeType: string | undefined, name: string) => {
  const candidate = mimeType?.toLowerCase();
  if (
    candidate &&
    DOCUMENT_IMAGE_TYPES.includes(candidate as (typeof DOCUMENT_IMAGE_TYPES)[number])
  ) {
    return candidate;
  }
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return null;
};

export function Composer({
  botName,
  replyTarget,
  onClearReply,
  onSend,
}: {
  botName: string;
  replyTarget: ReplyTarget | null;
  onClearReply: () => void;
  onSend: (content: string, images: InlineImageInput[]) => Promise<void>;
}) {
  const theme = useTheme();
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(22);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const inputBaseline = useRef<number | null>(null);
  const replyProgress = useRef(new Animated.Value(replyTarget ? 1 : 0)).current;
  const hasText = text.trim().length > 0;
  const hasPayload = hasText || images.length > 0;

  const appendImages = (next: PendingImage[]) => {
    setImages((current) => [...current, ...next].slice(0, MAX_IMAGES));
  };

  const pickFromLibrary = async () => {
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      setAttachmentError(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    setPicking(true);
    setAttachmentError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: remaining > 1,
        orderedSelection: true,
        selectionLimit: remaining,
        base64: true,
        quality: 1,
        shouldDownloadFromNetwork: true,
      });
      if (result.canceled) return;
      const tooLarge = result.assets.find(
        (asset) => typeof asset.fileSize === "number" && asset.fileSize > MAX_IMAGE_BYTES
      );
      if (tooLarge) {
        setAttachmentError(`${tooLarge.fileName ?? "That image"} is larger than 20 MB.`);
        return;
      }
      const loaded = result.assets.flatMap((asset) =>
        asset.base64
          ? [
              {
                id: attachmentId(),
                url: `data:image/jpeg;base64,${asset.base64}`,
                alt: asset.fileName ?? "Photo",
              },
            ]
          : []
      );
      if (loaded.length === 0) {
        setAttachmentError("The selected image could not be read.");
        return;
      }
      appendImages(loaded);
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error ? cause.message : "The image picker could not open."
      );
    } finally {
      setPicking(false);
    }
  };

  const pickImageFiles = async () => {
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      setAttachmentError(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    setPicking(true);
    setAttachmentError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [...DOCUMENT_IMAGE_TYPES],
        multiple: remaining > 1,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const selected = result.assets.slice(0, remaining);
      const tooLarge = selected.find(
        (asset) => typeof asset.size === "number" && asset.size > MAX_IMAGE_BYTES
      );
      if (tooLarge) {
        setAttachmentError(`${tooLarge.name} is larger than 20 MB.`);
        return;
      }
      const loaded = await Promise.all(
        selected.map(async (asset): Promise<PendingImage> => {
          const mimeType = normalizedDocumentMime(asset.mimeType, asset.name);
          if (!mimeType) throw new Error("Choose PNG, JPEG, WebP, or GIF images.");
          const base64 = await FileSystem.readAsStringAsync(asset.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          return {
            id: attachmentId(),
            url: `data:${mimeType};base64,${base64}`,
            alt: asset.name,
          };
        })
      );
      appendImages(loaded);
      if (result.assets.length > remaining) {
        setAttachmentError(`Only the first ${remaining} images were added.`);
      }
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "The image could not be read.");
    } finally {
      setPicking(false);
    }
  };

  const takePhoto = async () => {
    if (images.length >= MAX_IMAGES) {
      setAttachmentError(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    setPicking(true);
    setAttachmentError(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setAttachmentError("Camera access is needed to take a photo.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        base64: true,
        quality: 1,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset?.base64) return;
      if (typeof asset.fileSize === "number" && asset.fileSize > MAX_IMAGE_BYTES) {
        setAttachmentError(`${asset.fileName ?? "That photo"} is larger than 20 MB.`);
        return;
      }
      appendImages([
        {
          id: attachmentId(),
          url: `data:image/jpeg;base64,${asset.base64}`,
          alt: asset.fileName ?? "Camera photo",
        },
      ]);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "The camera could not open.");
    } finally {
      setPicking(false);
    }
  };

  const showAttachmentMenu = () => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: "Add to message",
          options: ["Photo Library", "Choose Image File", "Take Photo", "Cancel"],
          cancelButtonIndex: 3,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) void pickFromLibrary();
          if (buttonIndex === 1) void pickImageFiles();
          if (buttonIndex === 2) void takePhoto();
        }
      );
      return;
    }
    Alert.alert("Add to message", undefined, [
      { text: "Photo Library", onPress: () => void pickFromLibrary() },
      { text: "Choose Image File", onPress: () => void pickImageFiles() },
      { text: "Take Photo", onPress: () => void takePhoto() },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const updateText = (value: string) => {
    setText(value);
    // iOS does not always emit a fresh content-size event for explicit newlines
    // inserted through dictation, hardware keyboards, or accessibility input.
    // Keep an exact line-count fallback so no entered line can be clipped.
    const explicitLineHeight = Math.max(22, value.split("\n").length * 22);
    setInputHeight(Math.min(102, explicitLineHeight));
  };

  const updateMeasuredHeight = (measuredHeight: number) => {
    if (text.length === 0) {
      inputBaseline.current = measuredHeight;
      setInputHeight(22);
      return;
    }

    const baseline = inputBaseline.current ?? measuredHeight;
    const wrappedHeight = Math.max(22, measuredHeight - baseline + 22);
    const explicitLineHeight = Math.max(22, text.split("\n").length * 22);
    setInputHeight(Math.min(102, Math.max(wrappedHeight, explicitLineHeight)));
  };

  useEffect(() => {
    Animated.spring(replyProgress, {
      toValue: replyTarget ? 1 : 0,
      damping: 19,
      stiffness: 240,
      mass: 0.82,
      useNativeDriver: false,
    }).start();
  }, [replyProgress, replyTarget]);

  const submit = async () => {
    const content = text.trim();
    if (!hasPayload || sending) return;
    setSending(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await onSend(
        content,
        images.map(({ url, alt }) => ({ url, alt }))
      );
      setText("");
      setImages([]);
      setAttachmentError(null);
      setInputHeight(22);
      Keyboard.dismiss();
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  const replyHeight = replyProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 36] });
  const verticalPadding = inputHeight > 32 ? 8 : 11;

  return (
    <View style={styles.outer}>
      <IconButton
        label="Add attachment"
        name="plus"
        disabled={sending || picking}
        onPress={showAttachmentMenu}
        size={44}
        symbolSize={20}
        tone="surface"
      />
      <GlassSurface
        fallbackColor={theme.field}
        interactive
        style={[
          styles.composer,
          {
            borderColor: theme.border,
            shadowColor: theme.dark ? "#000" : "#6A6A65",
          },
        ]}
      >
        <Animated.View
          pointerEvents={replyTarget ? "auto" : "none"}
          style={[
            styles.replyTray,
            {
              height: replyHeight,
              opacity: replyProgress,
              transform: [
                {
                  scale: replyProgress.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }),
                },
              ],
            },
          ]}
        >
          <View style={[styles.replyInner, { backgroundColor: theme.surface }]}>
            <SymbolView name="arrowshape.turn.up.left" size={14} tintColor={theme.textMuted} />
            <Text numberOfLines={1} style={[styles.replyCopy, { color: theme.textMuted }]}>
              {replyTarget?.content ?? ""}
            </Text>
            <Pressable
              accessibilityLabel="Cancel reply"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onClearReply}
              style={({ pressed }) => [
                styles.close,
                pressed && { backgroundColor: theme.surfacePressed },
              ]}
            >
              <SymbolView name="xmark" size={14} tintColor={theme.textMuted} weight="semibold" />
            </Pressable>
          </View>
        </Animated.View>

        {images.length > 0 ? (
          <View accessibilityLabel={`${images.length} attached images`} style={styles.imageRail}>
            {images.map((image) => (
              <View key={image.id} style={styles.imagePreviewWrap}>
                <Image source={{ uri: image.url }} style={styles.imagePreview} />
                <Pressable
                  accessibilityLabel={`Remove ${image.alt ?? "image"}`}
                  accessibilityRole="button"
                  hitSlop={5}
                  onPress={() =>
                    setImages((current) => current.filter(({ id }) => id !== image.id))
                  }
                  style={styles.removeImage}
                >
                  <SymbolView name="xmark" size={10} tintColor="#FFFFFF" weight="bold" />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {attachmentError ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.attachmentError, { color: theme.danger }]}
          >
            {attachmentError}
          </Text>
        ) : null}

        <View style={styles.inputRow}>
          <TextInput
            accessibilityLabel={`Message ${botName}`}
            blurOnSubmit={false}
            multiline
            onChangeText={updateText}
            onContentSizeChange={(event) =>
              updateMeasuredHeight(event.nativeEvent.contentSize.height)
            }
            placeholder={`Message ${botName}`}
            placeholderTextColor={theme.textFaint}
            returnKeyType="default"
            scrollEnabled={inputHeight >= 102}
            selectionColor={theme.accent}
            style={[
              styles.input,
              {
                color: theme.text,
                height: inputHeight,
                marginTop: verticalPadding,
                marginBottom: verticalPadding,
              },
            ]}
            value={text}
          />
          {hasPayload ? (
            <IconButton
              label="Send message"
              name="arrow.up"
              disabled={sending}
              onPress={() => void submit()}
              size={34}
              symbolSize={17}
              tone="dark"
            />
          ) : (
            <IconButton
              label="Dictate message"
              name="mic"
              size={34}
              symbolSize={17}
              tone={theme.dark ? "dark" : "subtle"}
            />
          )}
        </View>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 2,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  composer: {
    flex: 1,
    minHeight: metrics.composerMinHeight,
    maxHeight: metrics.composerMaxHeight,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowOpacity: 0.09,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 3 },
  },
  replyTray: { overflow: "hidden" },
  replyInner: {
    height: 31,
    borderRadius: 15.5,
    marginHorizontal: 6,
    marginTop: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingLeft: 9,
    paddingRight: 2,
  },
  replyCopy: { flex: 1, fontSize: 13, lineHeight: 17 },
  imageRail: {
    minHeight: 64,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 1,
  },
  imagePreviewWrap: { width: 56, height: 56 },
  imagePreview: { width: 56, height: 56, borderRadius: 11, backgroundColor: "#D6D6D2" },
  removeImage: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,10,10,0.86)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.75)",
  },
  attachmentError: { paddingHorizontal: 12, paddingTop: 4, fontSize: 11, lineHeight: 14 },
  close: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  inputRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingLeft: 10,
    paddingRight: 2,
  },
  input: {
    flex: 1,
    minHeight: 22,
    maxHeight: 102,
    paddingHorizontal: 4,
    paddingVertical: 0,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: -0.12,
  },
});
