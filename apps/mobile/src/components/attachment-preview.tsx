import type { AssetKind, AssetRef } from "@openbot/contracts";
import { openBotNativeAvailable, openPreview } from "@openbot/mobile-native";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { Directory, File, Paths } from "expo-file-system";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { authHeadersForUrl } from "../auth";
import { useTheme } from "../theme";

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

const cacheName = (asset: AssetRef) => {
  const safeName = asset.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-96) || "preview";
  return `${asset.assetId.slice(0, 16)}-${safeName}`;
};

export function AttachmentPreview({ asset, url }: { asset: AssetRef; url: string | null }) {
  const theme = useTheme();
  const [state, setState] = useState<"idle" | "downloading" | "opening" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    []
  );

  const open = async () => {
    if (!url || state === "downloading" || state === "opening") return;
    setError(null);
    if (!openBotNativeAvailable) {
      await Linking.openURL(url);
      return;
    }
    const nextController = new AbortController();
    controller.current = nextController;
    try {
      const cache = new Directory(Paths.cache, "openbot-previews");
      cache.create({ idempotent: true, intermediates: true });
      const destination = new File(cache, cacheName(asset));
      let localFile = destination;
      if (!destination.exists || destination.size !== asset.byteSize) {
        if (destination.exists) destination.delete();
        setState("downloading");
        setProgress(0);
        const downloaded = await File.createDownloadTask(url, destination, {
          headers: authHeadersForUrl(url),
          sessionType: "foreground",
          signal: nextController.signal,
          onProgress: ({ bytesWritten, totalBytes }) => {
            if (totalBytes > 0) setProgress(Math.max(0, Math.min(1, bytesWritten / totalBytes)));
          },
        }).downloadAsync();
        if (!downloaded) throw new Error("The preview download did not finish.");
        localFile = downloaded;
      }
      if (nextController.signal.aborted) return;
      setState("opening");
      const opened = await openPreview(localFile.uri);
      if (!opened) await Linking.openURL(url);
      setState("idle");
      setProgress(0);
    } catch (cause) {
      if (nextController.signal.aborted) {
        setState("idle");
        setProgress(0);
        return;
      }
      setState("error");
      setError(clientErrorMessage(cause, "This file could not be previewed."));
    } finally {
      if (controller.current === nextController) controller.current = null;
    }
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setState("idle");
    setProgress(0);
  };

  return (
    <Pressable
      accessibilityHint="Downloads a temporary copy and opens the native document preview"
      accessibilityLabel={`${state === "error" ? "Retry" : "Preview"} ${asset.fileName}`}
      accessibilityRole="button"
      onPress={() => void open()}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.surface,
          borderColor: state === "error" ? theme.danger : theme.border,
          opacity: pressed ? 0.74 : 1,
        },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: theme.surfacePressed }]}>
        <SymbolView name={fileSymbol(asset.kind)} size={15} tintColor={theme.textMuted} />
      </View>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {asset.fileName}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.meta, { color: error ? theme.danger : theme.textMuted }]}
        >
          {error
            ? "Preview failed — tap to retry"
            : state === "downloading"
              ? `Downloading ${Math.max(1, Math.round(progress * 100))}%`
              : state === "opening"
                ? "Opening preview…"
                : readableSize(asset.byteSize)}
        </Text>
        {state === "downloading" ? (
          <View style={[styles.progressTrack, { backgroundColor: theme.surfacePressed }]}>
            <View
              style={[
                styles.progressFill,
                {
                  backgroundColor: theme.text,
                  width: `${Math.max(3, progress * 100)}%`,
                },
              ]}
            />
          </View>
        ) : null}
      </View>
      {state === "downloading" ? (
        <Pressable
          accessibilityLabel={`Cancel download ${asset.fileName}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation();
            cancel();
          }}
          style={styles.action}
        >
          <SymbolView name="xmark.circle.fill" size={19} tintColor={theme.textMuted} />
        </Pressable>
      ) : state === "error" ? (
        <SymbolView name="arrow.clockwise.circle" size={19} tintColor={theme.danger} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 50,
    alignSelf: "flex-start",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { minWidth: 78, maxWidth: 174, gap: 1 },
  title: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  meta: { fontSize: 11, lineHeight: 14 },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    overflow: "hidden",
    marginTop: 2,
  },
  progressFill: { height: 3, borderRadius: 2 },
  action: {
    width: 32,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
