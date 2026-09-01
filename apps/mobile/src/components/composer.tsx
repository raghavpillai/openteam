import { MAX_PARALLEL_UPLOADS, mapWithConcurrency } from "@openbot/client-core/async";
import type { AssetRef, ClientCapabilities } from "@openbot/contracts";
import { CLIENT_CAPABILITIES } from "@openbot/contracts/capabilities";
import { isCameraAvailable } from "@openbot/mobile-native";
import {
  attachmentByteLimit,
  attachmentOverflowMessage,
  firstOversizedAttachment,
  formatAttachmentBytes,
  remainingAttachmentCapacity,
} from "@openbot/product-core/attachments";
import type { DurableStagedAttachment } from "@openbot/product-core/durable-delivery";
import {
  filterMentionOptions,
  insertPlainTextMention,
  type MentionOption,
} from "@openbot/product-core/mentions";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { authHeadersForUrl } from "../auth";
import { DraftHydrationGuard } from "../draft-hydration";
import {
  type ConversationDraft,
  flushConversationDraftWrites,
  loadConversationDraft,
  newConversationDraftId,
  saveConversationDraft,
} from "../drafts";
import { metrics, useTheme } from "../theme";
import { useVoiceInput } from "../use-voice-input";
import { GlassSurface } from "./glass-surface";
import { IconButton } from "./icon-button";

export interface ReplyTarget {
  id: string;
  content: string;
}

export interface ComposerRecovery {
  id: string;
  text: string;
  attachments: AssetRef[];
  stagedAttachments?: DurableStagedAttachment[];
  replyTarget: ReplyTarget | null;
}

interface AttachmentSource {
  uri: string;
  fileName: string;
  mimeType?: string;
  alt?: string;
  byteSize?: number | null;
  previewKind: "image" | "file";
}

interface PendingAttachment {
  id: string;
  state: "uploading" | "ready" | "error";
  progress: number;
  source: AttachmentSource | null;
  asset: AssetRef | null;
  staged: DurableStagedAttachment | null;
  error: string | null;
  recoveryOwned?: boolean;
}

const VOICE_LEVEL_KEYS = Array.from({ length: 12 }, (_, index) => `voice-level-${index}`);

const attachmentId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const normalizedImageMime = (mimeType: string | undefined, name: string) => {
  const candidate = mimeType?.toLowerCase();
  if (candidate?.startsWith("image/")) {
    return candidate;
  }
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/jpeg";
};

const recordingTime = (elapsedMs: number) => {
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function Composer({
  draftKey,
  botName,
  placeholder,
  mentionOptions = [],
  replyTarget,
  replyEditVersion,
  recovery,
  onRecoveryApplied,
  onRecoveryConsumed,
  onRestoreReply,
  onClearReply,
  onSend,
  onStage,
  onDiscardStages,
  onUpload,
  assetUrl,
  uploadCapabilities = CLIENT_CAPABILITIES.uploads,
}: {
  draftKey: string;
  botName: string;
  placeholder?: string;
  mentionOptions?: readonly MentionOption[];
  replyTarget: ReplyTarget | null;
  replyEditVersion: number;
  recovery?: ComposerRecovery | null;
  onRecoveryApplied?: (id: string) => void;
  onRecoveryConsumed?: (nonce: string) => Promise<void>;
  onRestoreReply: (target: ReplyTarget | null) => void;
  onClearReply: () => void;
  onSend: (
    content: string,
    attachments: AssetRef[],
    stagedAttachments: DurableStagedAttachment[],
    consumedDraft: { key: string; id: string }
  ) => Promise<void>;
  onStage: (source: AttachmentSource) => Promise<DurableStagedAttachment>;
  onDiscardStages?: (attachments: readonly DurableStagedAttachment[]) => Promise<void>;
  onUpload: (input: {
    uri: string;
    fileName: string;
    mimeType?: string;
    alt?: string;
    signal?: AbortSignal;
    onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void;
  }) => Promise<AssetRef>;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">) => string | null;
  uploadCapabilities?: ClientCapabilities["uploads"];
}) {
  const theme = useTheme();
  const inputPlaceholder = placeholder ?? `Message ${botName}`;
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(22);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftId, setDraftId] = useState(newConversationDraftId);
  const [recoveryNonce, setRecoveryNonce] = useState<string | null>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const appliedRecoveryNonce = useRef<string | null>(null);
  const textInputRef = useRef<TextInput>(null);
  const inputBaseline = useRef<number | null>(null);
  const replyProgress = useRef(new Animated.Value(replyTarget ? 1 : 0)).current;
  const latestDraft = useRef<ConversationDraft>({
    id: draftId,
    text: "",
    attachments: [],
    stagedAttachments: [],
    replyTarget: null,
  });
  const draftReadyRef = useRef(false);
  const draftHydrationGuardRef = useRef(new DraftHydrationGuard());
  const latestReplyEditVersion = useRef(replyEditVersion);
  const latestText = useRef(text);
  const latestAttachments = useRef<PendingAttachment[]>([]);
  const sendAfterVoice = useRef(false);
  latestReplyEditVersion.current = replyEditVersion;
  const readyAssets = useMemo(
    () =>
      attachments.flatMap((attachment) =>
        attachment.state === "ready" && attachment.asset ? [attachment.asset] : []
      ),
    [attachments]
  );
  const hasText = text.trim().length > 0;
  const hasPayload = hasText || attachments.length > 0;
  latestText.current = text;
  latestAttachments.current = attachments;
  const voice = useVoiceInput((transcript) => {
    const existing = latestText.current.trimEnd();
    const nextText = existing ? `${existing} ${transcript}` : transcript;
    updateText(nextText);
    if (sendAfterVoice.current) {
      sendAfterVoice.current = false;
      void submitPayload(nextText.trim(), latestAttachments.current);
    }
  });
  const voiceActive =
    voice.state === "requesting" || voice.state === "recording" || voice.state === "processing";
  useEffect(() => {
    if (voice.state === "idle" || voice.state === "error") {
      sendAfterVoice.current = false;
    }
  }, [voice.state]);
  const mentionMatch = text.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase("en-US") ?? null;
  const visibleMentions =
    mentionQuery === null ? [] : filterMentionOptions(mentionOptions, mentionQuery).slice(0, 4);

  const chooseMention = (option: MentionOption) => {
    if (!mentionMatch || mentionQuery === null) return;
    updateText(
      insertPlainTextMention(text, mentionMatch.index ?? 0, mentionMatch[0], option.handle)
    );
    requestAnimationFrame(() => textInputRef.current?.focus());
  };

  useEffect(() => {
    let active = true;
    const draftHydrationGuard = draftHydrationGuardRef.current;
    const hydrationCheckpoint = draftHydrationGuard.checkpoint();
    const replyVersion = latestReplyEditVersion.current;
    draftReadyRef.current = false;
    setDraftReady(false);
    setDraftId(newConversationDraftId());
    setRecoveryNonce(null);
    appliedRecoveryNonce.current = null;
    void loadConversationDraft(draftKey)
      .then((draft) => {
        if (!active) return;
        setDraftId(draft?.id ?? newConversationDraftId());
        setRecoveryNonce(draft?.recoveryNonce ?? null);
        appliedRecoveryNonce.current = draft?.recoveryNonce ?? null;
        if (draftHydrationGuard.isUntouched(hydrationCheckpoint, "text")) {
          setText(draft?.text ?? "");
        }
        if (draftHydrationGuard.isUntouched(hydrationCheckpoint, "attachments")) {
          setAttachments([
            ...(draft?.attachments.map((asset) => ({
              id: attachmentId(),
              state: "ready" as const,
              progress: 1,
              source: null,
              asset,
              staged: null,
              error: null,
            })) ?? []),
            ...(draft?.stagedAttachments.map((staged) => ({
              id: attachmentId(),
              state: "error" as const,
              progress: 1,
              source: {
                uri: staged.previewUri ?? "",
                fileName: staged.fileName,
                mimeType: staged.mimeType,
                byteSize: staged.byteSize,
                alt: staged.alt,
                previewKind: staged.kind === "image" ? ("image" as const) : ("file" as const),
              },
              asset: null,
              staged,
              error: null,
            })) ?? []),
          ]);
        }
        if (
          latestReplyEditVersion.current === replyVersion &&
          draftHydrationGuard.isUntouched(hydrationCheckpoint, "reply")
        ) {
          onRestoreReply(draft?.replyTarget ?? null);
        }
      })
      .catch(() => {
        if (!active) return;
        if (draftHydrationGuard.isUntouched(hydrationCheckpoint, "text")) setText("");
        if (draftHydrationGuard.isUntouched(hydrationCheckpoint, "attachments")) {
          setAttachments([]);
        }
        if (
          latestReplyEditVersion.current === replyVersion &&
          draftHydrationGuard.isUntouched(hydrationCheckpoint, "reply")
        ) {
          onRestoreReply(null);
        }
      })
      .finally(() => {
        if (active) {
          draftReadyRef.current = true;
          setDraftReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [draftKey, onRestoreReply]);

  useEffect(() => {
    if (!draftReady || sending) return;
    latestDraft.current = {
      id: draftId,
      text,
      attachments: readyAssets,
      stagedAttachments: attachments.flatMap((attachment) =>
        attachment.staged ? [attachment.staged] : []
      ),
      replyTarget,
      ...(recoveryNonce ? { recoveryNonce } : {}),
    };
    const timeout = setTimeout(() => {
      void saveConversationDraft(draftKey, latestDraft.current);
    }, 250);
    return () => clearTimeout(timeout);
  }, [
    attachments,
    draftId,
    draftKey,
    draftReady,
    readyAssets,
    recoveryNonce,
    replyTarget,
    sending,
    text,
  ]);

  useEffect(() => {
    if (!draftReady || !recovery) return;
    // Mirror Grok's parked-draft behavior: a cancelled queued send never
    // overwrites work the user has already started in the composer.
    if (text.trim() || attachments.length > 0 || replyTarget) return;
    draftHydrationGuardRef.current.markEdited("text");
    draftHydrationGuardRef.current.markEdited("attachments");
    draftHydrationGuardRef.current.markEdited("reply");
    setText(recovery.text);
    appliedRecoveryNonce.current = recovery.id;
    setRecoveryNonce(recovery.id);
    setInputHeight(Math.min(102, Math.max(22, recovery.text.split("\n").length * 22)));
    setAttachments([
      ...recovery.attachments.map((asset) => ({
        id: attachmentId(),
        state: "ready" as const,
        progress: 1,
        source: null,
        asset,
        staged: null,
        error: null,
      })),
      ...(recovery.stagedAttachments ?? []).map((staged) => ({
        id: attachmentId(),
        state: "error" as const,
        progress: 1,
        source: {
          uri: staged.previewUri ?? "",
          fileName: staged.fileName,
          mimeType: staged.mimeType,
          byteSize: staged.byteSize,
          alt: staged.alt,
          previewKind: staged.kind === "image" ? ("image" as const) : ("file" as const),
        },
        asset: null,
        staged,
        error: null,
        recoveryOwned: true,
      })),
    ]);
    onRestoreReply(recovery.replyTarget);
    onRecoveryApplied?.(recovery.id);
    requestAnimationFrame(() => textInputRef.current?.focus());
  }, [
    attachments.length,
    draftReady,
    onRecoveryApplied,
    onRestoreReply,
    recovery,
    replyTarget,
    text,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of uploadControllers.current.values()) controller.abort();
      uploadControllers.current.clear();
    };
  }, []);

  useEffect(
    () => () => {
      if (draftReadyRef.current) {
        void saveConversationDraft(draftKey, latestDraft.current).then(
          flushConversationDraftWrites,
          () => undefined
        );
      }
    },
    [draftKey]
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" || !draftReadyRef.current) return;
      void saveConversationDraft(draftKey, latestDraft.current).then(
        flushConversationDraftWrites,
        () => undefined
      );
    });
    return () => subscription.remove();
  }, [draftKey]);

  const updateAttachment = (id: string, update: Partial<PendingAttachment>) => {
    if (!mounted.current) return;
    draftHydrationGuardRef.current.markEdited("attachments");
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...update } : attachment
      )
    );
  };

  const uploadAttachment = async (attachment: PendingAttachment) => {
    const source = attachment.source;
    if (!source) return;
    const controller = new AbortController();
    uploadControllers.current.set(attachment.id, controller);
    updateAttachment(attachment.id, { state: "uploading", progress: 0, error: null });
    try {
      const asset = await onUpload({
        uri: source.uri,
        fileName: source.fileName,
        mimeType: source.mimeType,
        alt: source.alt,
        signal: controller.signal,
        onProgress: ({ bytesSent, totalBytes }) => {
          if (totalBytes <= 0) return;
          updateAttachment(attachment.id, {
            progress: Math.max(0, Math.min(1, bytesSent / totalBytes)),
          });
        },
      });
      if (attachment.staged && !attachment.recoveryOwned) {
        await onDiscardStages?.([attachment.staged]);
      }
      updateAttachment(attachment.id, {
        state: "ready",
        progress: 1,
        asset,
        staged: null,
        error: null,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      updateAttachment(attachment.id, {
        state: "error",
        error: clientErrorMessage(cause, "Upload failed"),
      });
    } finally {
      if (uploadControllers.current.get(attachment.id) === controller) {
        uploadControllers.current.delete(attachment.id);
      }
    }
  };

  const stageAttachments = (sources: AttachmentSource[]) => {
    if (sources.length === 0) return;
    const staged = sources.map(
      (source): PendingAttachment => ({
        id: attachmentId(),
        state: "uploading",
        progress: 0,
        source,
        asset: null,
        staged: null,
        error: null,
      })
    );
    draftHydrationGuardRef.current.markEdited("attachments");
    setAttachments((current) =>
      [...current, ...staged].slice(0, uploadCapabilities.maxAttachmentsPerMessage)
    );
    void mapWithConcurrency(staged, MAX_PARALLEL_UPLOADS, uploadAttachment);
  };

  const consumeEmptyRecovery = (nextText: string, nextAttachmentCount: number) => {
    const nonce = appliedRecoveryNonce.current;
    if (!nonce || nextText.trim() || nextAttachmentCount > 0) return;
    appliedRecoveryNonce.current = null;
    setRecoveryNonce(null);
    void onRecoveryConsumed?.(nonce);
  };

  const removeAttachment = (attachment: PendingAttachment) => {
    uploadControllers.current.get(attachment.id)?.abort();
    uploadControllers.current.delete(attachment.id);
    if (attachment.staged && !attachment.recoveryOwned) {
      void onDiscardStages?.([attachment.staged]);
    }
    draftHydrationGuardRef.current.markEdited("attachments");
    const next = latestAttachments.current.filter(({ id }) => id !== attachment.id);
    setAttachments(next);
    consumeEmptyRecovery(latestText.current, next.length);
  };

  const pickFromLibrary = async () => {
    const remaining = remainingAttachmentCapacity(attachments.length, uploadCapabilities);
    if (remaining <= 0) {
      setAttachmentError(
        `You can attach up to ${uploadCapabilities.maxAttachmentsPerMessage} files.`
      );
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
        base64: false,
        quality: 1,
        shouldDownloadFromNetwork: true,
      });
      if (result.canceled) return;
      const tooLarge = firstOversizedAttachment(
        result.assets.map((asset) => {
          const fileName = asset.fileName ?? "photo.jpg";
          return {
            fileName,
            mimeType: normalizedImageMime(asset.mimeType, fileName),
            byteSize: asset.fileSize,
          };
        }),
        uploadCapabilities
      );
      if (tooLarge) {
        setAttachmentError(
          `${tooLarge.candidate.fileName || "That image"} is larger than ${formatAttachmentBytes(tooLarge.limit)}.`
        );
        return;
      }
      if (result.assets.length === 0) {
        setAttachmentError("The selected image could not be read.");
        return;
      }
      stageAttachments(
        result.assets.map((asset) => {
          const fileName = asset.fileName ?? `photo-${Date.now()}.jpg`;
          return {
            uri: asset.uri,
            fileName,
            mimeType: normalizedImageMime(asset.mimeType, fileName),
            byteSize: asset.fileSize,
            alt: asset.fileName ?? "Photo",
            previewKind: "image" as const,
          };
        })
      );
    } catch (cause) {
      setAttachmentError(clientErrorMessage(cause, "The image picker could not open."));
    } finally {
      setPicking(false);
    }
  };

  const pickFiles = async () => {
    const remaining = remainingAttachmentCapacity(attachments.length, uploadCapabilities);
    if (remaining <= 0) {
      setAttachmentError(
        `You can attach up to ${uploadCapabilities.maxAttachmentsPerMessage} files.`
      );
      return;
    }
    setPicking(true);
    setAttachmentError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: remaining > 1,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const selected = result.assets.slice(0, remaining);
      const tooLarge = firstOversizedAttachment(
        selected.map((asset) => ({
          fileName: asset.name,
          mimeType: asset.mimeType,
          byteSize: asset.size,
        })),
        uploadCapabilities
      );
      if (tooLarge) {
        setAttachmentError(
          `${tooLarge.candidate.fileName} is larger than ${formatAttachmentBytes(tooLarge.limit)}.`
        );
        return;
      }
      stageAttachments(
        selected.map((asset) => ({
          uri: asset.uri,
          fileName: asset.name,
          mimeType: asset.mimeType ?? undefined,
          byteSize: asset.size,
          alt: asset.name,
          previewKind: asset.mimeType?.startsWith("image/")
            ? ("image" as const)
            : ("file" as const),
        }))
      );
      if (result.assets.length > remaining) {
        setAttachmentError(attachmentOverflowMessage(remaining));
      }
    } catch (cause) {
      setAttachmentError(clientErrorMessage(cause, "The file could not be read."));
    } finally {
      setPicking(false);
    }
  };

  const takePhoto = async () => {
    if (remainingAttachmentCapacity(attachments.length, uploadCapabilities) <= 0) {
      setAttachmentError(
        `You can attach up to ${uploadCapabilities.maxAttachmentsPerMessage} files.`
      );
      return;
    }
    // expo-image-picker presents an unavailable UIImagePickerController camera
    // source as an uncaught native exception on iOS simulators. Check the real
    // UIKit capability before asking for permission or launching the picker.
    if (isCameraAvailable() === false) {
      setAttachmentError("Camera capture is not available on this device.");
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
        base64: false,
        quality: 1,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const fileName = asset.fileName ?? `camera-${Date.now()}.jpg`;
      const mimeType = normalizedImageMime(asset.mimeType, fileName);
      const limit = attachmentByteLimit({ fileName, mimeType }, uploadCapabilities);
      if (typeof asset.fileSize === "number" && asset.fileSize > limit) {
        setAttachmentError(
          `${asset.fileName ?? "That photo"} is larger than ${formatAttachmentBytes(limit)}.`
        );
        return;
      }
      stageAttachments([
        {
          uri: asset.uri,
          fileName,
          mimeType,
          byteSize: asset.fileSize,
          alt: asset.fileName ?? "Camera photo",
          previewKind: "image",
        },
      ]);
    } catch (cause) {
      setAttachmentError(clientErrorMessage(cause, "The camera could not open."));
    } finally {
      setPicking(false);
    }
  };

  const showAttachmentMenu = () => {
    setAttachmentMenuOpen(true);
  };

  const updateText = (value: string) => {
    draftHydrationGuardRef.current.markEdited("text");
    setText(value);
    consumeEmptyRecovery(value, latestAttachments.current.length);
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

  const submitPayload = async (content: string, pending: PendingAttachment[]) => {
    if ((!content && pending.length === 0) || sending) return;
    setSending(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
    let recoverable = pending;
    // Clear on the tap, not after the journal fsync. The captured payload is
    // restored below if staging or durable persistence fails.
    setText("");
    latestAttachments.current = [];
    setAttachments([]);
    setAttachmentError(null);
    setInputHeight(22);
    try {
      const prepared = await mapWithConcurrency(
        pending,
        MAX_PARALLEL_UPLOADS,
        async (
          attachment
        ): Promise<
          { asset: AssetRef; staged?: never } | { asset?: never; staged: DurableStagedAttachment }
        > => {
          if (attachment.asset) return { asset: attachment.asset };
          if (attachment.staged) return { staged: attachment.staged };
          if (!attachment.source) throw new Error("The attachment is no longer available.");
          return { staged: await onStage(attachment.source) };
        }
      );
      const assets = prepared.flatMap((attachment) => (attachment.asset ? [attachment.asset] : []));
      const stagedAttachments = prepared.flatMap((attachment, index) =>
        attachment.staged ? [{ ...attachment.staged, position: index }] : []
      );
      recoverable = pending.map((attachment, index) => ({
        ...attachment,
        ...(prepared[index]?.staged
          ? { staged: prepared[index].staged, state: "error" as const, progress: 1, error: null }
          : {}),
      }));
      await onSend(content, assets, stagedAttachments, { key: draftKey, id: draftId });
      const recoveryNonce = appliedRecoveryNonce.current;
      if (recoveryNonce) {
        await onRecoveryConsumed?.(recoveryNonce);
        appliedRecoveryNonce.current = null;
        setRecoveryNonce(null);
      }
      setDraftId(newConversationDraftId());
      Keyboard.dismiss();
    } catch (cause) {
      setText(content);
      latestAttachments.current = recoverable;
      setAttachments(recoverable);
      setAttachmentError(clientErrorMessage(cause, "The message could not be sent."));
    } finally {
      setSending(false);
    }
  };

  const submit = () => submitPayload(text.trim(), latestAttachments.current);

  const replyHeight = replyProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 36] });
  const verticalPadding = inputHeight > 32 ? 8 : 11;

  return (
    <View style={styles.outer}>
      <Modal
        animationType="fade"
        onRequestClose={() => setAttachmentMenuOpen(false)}
        statusBarTranslucent
        transparent
        visible={attachmentMenuOpen}
      >
        <View style={styles.attachmentMenuLayer}>
          <Pressable
            accessibilityLabel="Close attachment menu"
            onPress={() => setAttachmentMenuOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <GlassSurface
            fallbackColor={theme.dark ? "rgba(55,55,55,0.97)" : "rgba(245,245,245,0.98)"}
            style={[styles.attachmentMenu, { borderColor: theme.border }]}
          >
            <Pressable
              accessibilityLabel="Attach Image"
              accessibilityRole="button"
              onPress={() => {
                setAttachmentMenuOpen(false);
                void pickFromLibrary();
              }}
              style={({ pressed }) => [styles.attachmentMenuItem, pressed && styles.menuPressed]}
            >
              <SymbolView name="photo.on.rectangle" size={18} tintColor={theme.text} />
              <Text style={[styles.attachmentMenuLabel, { color: theme.text }]}>Attach Image</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Take Photo"
              accessibilityRole="button"
              disabled={isCameraAvailable() === false}
              onPress={() => {
                setAttachmentMenuOpen(false);
                void takePhoto();
              }}
              style={({ pressed }) => [
                styles.attachmentMenuItem,
                pressed && styles.menuPressed,
                isCameraAvailable() === false && styles.disabledMenuItem,
              ]}
            >
              <SymbolView name="camera" size={18} tintColor={theme.text} />
              <Text style={[styles.attachmentMenuLabel, { color: theme.text }]}>Take Photo</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Choose File"
              accessibilityRole="button"
              onPress={() => {
                setAttachmentMenuOpen(false);
                void pickFiles();
              }}
              style={({ pressed }) => [styles.attachmentMenuItem, pressed && styles.menuPressed]}
            >
              <SymbolView name="folder" size={18} tintColor={theme.text} />
              <Text style={[styles.attachmentMenuLabel, { color: theme.text }]}>Choose File</Text>
            </Pressable>
          </GlassSurface>
        </View>
      </Modal>
      <IconButton
        label="Add attachment"
        name="plus"
        disabled={sending || picking}
        haptic="light"
        onPress={showAttachmentMenu}
        size={38}
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
              onPress={() => {
                draftHydrationGuardRef.current.markEdited("reply");
                onClearReply();
              }}
              style={({ pressed }) => [
                styles.close,
                pressed && { backgroundColor: theme.surfacePressed },
              ]}
            >
              <SymbolView name="xmark" size={14} tintColor={theme.textMuted} weight="semibold" />
            </Pressable>
          </View>
        </Animated.View>

        {attachments.length > 0 ? (
          <View
            accessibilityLabel={`${attachments.length} attached files`}
            style={styles.attachmentRail}
          >
            {attachments.map((attachment) => {
              const url = attachment.asset ? assetUrl(attachment.asset) : attachment.source?.uri;
              const fileName = attachment.asset?.fileName ?? attachment.source?.fileName ?? "File";
              const isImage =
                attachment.asset?.kind === "image" || attachment.source?.previewKind === "image";
              return (
                <View key={attachment.id} style={styles.attachmentPreviewWrap}>
                  {isImage && url ? (
                    <Image
                      source={{
                        uri: url,
                        ...(attachment.asset ? { headers: authHeadersForUrl(url) } : {}),
                      }}
                      style={styles.imagePreview}
                    />
                  ) : (
                    <View
                      style={[
                        styles.filePreview,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                      ]}
                    >
                      <SymbolView name="doc.fill" size={20} tintColor={theme.textMuted} />
                      <Text numberOfLines={1} style={[styles.fileName, { color: theme.textMuted }]}>
                        {fileName}
                      </Text>
                    </View>
                  )}
                  {attachment.state !== "ready" ? (
                    <View style={styles.uploadOverlay}>
                      {attachment.state === "uploading" ? (
                        <>
                          <Text style={styles.uploadPercent}>
                            {Math.max(1, Math.round(attachment.progress * 100))}%
                          </Text>
                          <View style={styles.progressTrack}>
                            <View
                              style={[
                                styles.progressFill,
                                { width: `${Math.max(4, attachment.progress * 100)}%` },
                              ]}
                            />
                          </View>
                        </>
                      ) : (
                        <Pressable
                          accessibilityLabel={`Retry upload ${fileName}`}
                          accessibilityRole="button"
                          onPress={() => void uploadAttachment(attachment)}
                          style={styles.retryUpload}
                        >
                          <SymbolView name="arrow.clockwise" size={14} tintColor="#FFFFFF" />
                          <Text style={styles.retryUploadLabel}>Retry</Text>
                        </Pressable>
                      )}
                    </View>
                  ) : null}
                  <Pressable
                    accessibilityLabel={
                      attachment.state === "uploading"
                        ? `Cancel upload ${fileName}`
                        : `Remove ${fileName}`
                    }
                    accessibilityRole="button"
                    hitSlop={5}
                    onPress={() => removeAttachment(attachment)}
                    style={styles.removeImage}
                  >
                    <SymbolView name="xmark" size={10} tintColor="#FFFFFF" weight="bold" />
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : null}

        {attachmentError || voice.error ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.attachmentError, { color: theme.danger }]}
          >
            {attachmentError ?? voice.error}
          </Text>
        ) : null}

        {visibleMentions.length > 0 ? (
          <View
            accessibilityLabel="Mention suggestions"
            style={[styles.mentionList, { borderTopColor: theme.separator }]}
          >
            {visibleMentions.map((option) => (
              <Pressable
                accessibilityLabel={`Mention ${option.label}`}
                accessibilityRole="button"
                key={option.id}
                onPress={() => chooseMention(option)}
                style={({ pressed }) => [
                  styles.mention,
                  pressed && { backgroundColor: theme.surfacePressed },
                ]}
              >
                <Text style={[styles.mentionHandle, { color: theme.text }]}>@{option.handle}</Text>
                {option.label.toLocaleLowerCase("en-US") !== option.handle ? (
                  <Text numberOfLines={1} style={[styles.mentionLabel, { color: theme.textMuted }]}>
                    {option.label}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}

        {voiceActive ? (
          <View accessibilityLabel="Voice input" style={styles.voiceRow}>
            <IconButton
              label="Cancel voice input"
              name="xmark"
              onPress={voice.cancel}
              size={34}
              symbolSize={14}
              tone={theme.dark ? "dark" : "subtle"}
            />
            <View style={styles.voiceStatus}>
              <Text style={[styles.voiceLabel, { color: theme.text }]}>
                {voice.state === "requesting"
                  ? "Requesting microphone…"
                  : voice.state === "processing"
                    ? "Processing…"
                    : "Listening…"}
              </Text>
              <Text style={[styles.voiceTimer, { color: theme.textMuted }]}>
                {recordingTime(voice.elapsedMs)}
              </Text>
              {voice.state === "recording" ? (
                <View style={styles.waveform}>
                  {VOICE_LEVEL_KEYS.map((key, index) => (
                    <View
                      key={key}
                      style={[
                        styles.waveformBar,
                        {
                          backgroundColor: theme.textMuted,
                          height: 4 + (voice.levels[index] ?? 0.08) * 16,
                        },
                      ]}
                    />
                  ))}
                </View>
              ) : (
                <ActivityIndicator color={theme.textMuted} size="small" />
              )}
            </View>
            {voice.state === "recording" ? (
              <>
                <IconButton
                  label="Stop recording"
                  name="stop.fill"
                  onPress={voice.stop}
                  size={34}
                  symbolSize={12}
                  tone={theme.dark ? "dark" : "subtle"}
                />
                <IconButton
                  label="Transcribe and send"
                  name="arrow.up"
                  haptic="none"
                  onPress={() => {
                    sendAfterVoice.current = true;
                    voice.stop();
                  }}
                  size={34}
                  symbolSize={17}
                  tone="dark"
                />
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.inputRow}>
            <TextInput
              accessibilityLabel={inputPlaceholder}
              blurOnSubmit={false}
              keyboardAppearance={theme.dark ? "dark" : "light"}
              multiline
              onChangeText={updateText}
              onContentSizeChange={(event) =>
                updateMeasuredHeight(event.nativeEvent.contentSize.height)
              }
              placeholder={inputPlaceholder}
              placeholderTextColor={theme.textFaint}
              ref={textInputRef}
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
                haptic="none"
                onPress={() => void submit()}
                size={34}
                symbolSize={17}
                tone="dark"
              />
            ) : voice.available ? (
              <IconButton
                label="Start voice input"
                name="mic.fill"
                onPress={voice.start}
                size={34}
                symbolSize={16}
                tone={theme.dark ? "dark" : "subtle"}
              />
            ) : (
              <IconButton
                label="Open keyboard"
                name="keyboard"
                onPress={() => textInputRef.current?.focus()}
                size={34}
                symbolSize={17}
                tone={theme.dark ? "dark" : "subtle"}
              />
            )}
          </View>
        )}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  attachmentMenuLayer: { flex: 1 },
  attachmentMenu: {
    position: "absolute",
    left: 12,
    bottom: 18,
    width: 222,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 2,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  attachmentMenuItem: {
    height: 42,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  attachmentMenuLabel: { fontSize: 15, lineHeight: 20 },
  menuPressed: { backgroundColor: "rgba(255,255,255,0.08)" },
  disabledMenuItem: { opacity: 0.35 },
  outer: {
    paddingHorizontal: 24,
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
  attachmentRail: {
    minHeight: 64,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 1,
  },
  attachmentPreviewWrap: { width: 72, height: 56 },
  imagePreview: { width: 56, height: 56, borderRadius: 11, backgroundColor: "#D6D6D2" },
  filePreview: {
    width: 72,
    height: 56,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  fileName: { width: "100%", textAlign: "center", fontSize: 9, lineHeight: 11 },
  uploadOverlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: 11,
    backgroundColor: "rgba(10,10,10,0.58)",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  uploadPercent: { color: "#FFFFFF", fontSize: 10, lineHeight: 12, fontWeight: "700" },
  progressTrack: {
    width: 42,
    height: 3,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.32)",
  },
  progressFill: { height: 3, borderRadius: 2, backgroundColor: "#FFFFFF" },
  retryUpload: {
    minWidth: 44,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  retryUploadLabel: { color: "#FFFFFF", fontSize: 9, lineHeight: 11, fontWeight: "700" },
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
  mentionList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  mention: {
    minHeight: 38,
    borderRadius: 12,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  mentionHandle: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  mentionLabel: { flex: 1, fontSize: 12, lineHeight: 16 },
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
  voiceRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 2,
    gap: 2,
  },
  voiceStatus: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 5,
  },
  voiceLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  voiceTimer: { fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
  waveform: { flex: 1, height: 24, flexDirection: "row", alignItems: "center", gap: 2 },
  waveformBar: { flex: 1, maxWidth: 3, minHeight: 4, borderRadius: 2 },
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
