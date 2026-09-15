import * as Haptics from "../haptics";
import { SymbolView } from "expo-symbols";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { GlassSurface } from "./glass-surface";
import { authHeadersForUrl } from "../auth";

export interface ImageViewerItem {
  caption: string;
  uri: string;
  fileName: string;
  assetId?: string;
  byteSize?: number;
}

function ViewerImage({ item }: { item: ImageViewerItem }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <View style={[styles.stage, item.caption ? styles.stageWithCaption : null]}>
      <Image
        key={attempt}
        accessibilityLabel={item.caption}
        // Cached Fabric images can emit loadEnd before loadStart. Start from
        // loading on mount/retry and never regress after a completion event.
        onLoadEnd={() => setLoading(false)}
        onError={() => setFailed(true)}
        resizeMode="contain"
        source={{ uri: item.uri }}
        style={styles.image}
      />
      {loading ? <ActivityIndicator color="rgba(255,255,255,0.72)" style={styles.loader} /> : null}
      {failed ? (
        <View style={styles.imageError}>
          <Text accessibilityRole="alert" style={styles.errorLabel}>
            This image could not be loaded.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setFailed(false);
              setLoading(true);
              setAttempt((current) => current + 1);
            }}
            style={styles.retryButton}
          >
            <Text style={styles.errorLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function ImageViewer({
  item,
  onClose,
}: {
  item: ImageViewerItem | null;
  onClose: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  const shareRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      shareRequest.current?.abort();
    },
    [item]
  );

  const close = () => {
    onClose();
  };

  const share = async () => {
    if (!item || shareRequest.current) return;
    const request = new AbortController();
    shareRequest.current = request;
    setSharing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      let uri = item.uri;
      if (/^https?:/i.test(uri)) {
        const directory = new Directory(
          Paths.cache,
          "openteam-image-shares",
          item.assetId?.replace(/[^a-zA-Z0-9_-]/g, "-") || String(Date.now())
        );
        directory.create({ idempotent: true, intermediates: true });
        const fileName = item.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-96);
        const destination = new File(
          directory,
          fileName && fileName !== "." && fileName !== ".." ? fileName : "image.png"
        );
        if (
          !destination.exists ||
          (item.byteSize !== undefined && destination.size !== item.byteSize)
        ) {
          if (destination.exists) destination.delete();
          const file = await File.createDownloadTask(uri, destination, {
            headers: authHeadersForUrl(uri),
            sessionType: "foreground",
            signal: request.signal,
          }).downloadAsync();
          if (!file) throw new Error("Image download did not finish");
        }
        uri = destination.uri;
      }
      if (!request.signal.aborted) await Share.share({ title: item.fileName, url: uri });
    } catch {
      if (request.signal.aborted) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Couldn’t Share", "This image could not be shared right now.");
    } finally {
      if (shareRequest.current === request) shareRequest.current = null;
      setSharing(false);
    }
  };

  return (
    <Modal
      animationType="fade"
      navigationBarTranslucent
      onRequestClose={close}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible={item !== null}
    >
      <StatusBar animated barStyle="light-content" hidden />
      <SafeAreaProvider>
        <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
          <View style={styles.toolbar}>
            <GlassSurface
              fallbackColor="rgba(118,118,122,0.92)"
              interactive
              style={styles.shareGlass}
              tintColor="rgba(158,158,163,0.56)"
            >
              <Pressable
                accessibilityLabel="Save or share image"
                accessibilityRole="button"
                accessibilityState={{ busy: sharing, disabled: sharing }}
                disabled={sharing}
                hitSlop={8}
                onPress={() => void share()}
                style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}
              >
                {sharing ? (
                  <ActivityIndicator color="#050505" />
                ) : (
                  <SymbolView
                    name="square.and.arrow.down"
                    size={22}
                    tintColor="#050505"
                    weight="medium"
                  />
                )}
              </Pressable>
            </GlassSurface>

            <GlassSurface
              fallbackColor="rgba(118,118,122,0.92)"
              interactive
              style={styles.closeGlass}
              tintColor="rgba(158,158,163,0.56)"
            >
              <Pressable
                accessibilityLabel="Close image viewer"
                accessibilityRole="button"
                hitSlop={8}
                onPress={close}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              >
                <Text style={styles.closeLabel}>Close</Text>
              </Pressable>
            </GlassSurface>
          </View>

          {item ? <ViewerImage key={item.uri} item={item} /> : null}

          {item?.caption ? (
            <Text accessibilityRole="text" numberOfLines={3} style={styles.caption}>
              {item.caption}
            </Text>
          ) : null}
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  toolbar: {
    height: 64,
    paddingHorizontal: 14,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 11,
    zIndex: 2,
  },
  shareGlass: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: "hidden",
  },
  shareButton: { flex: 1, alignItems: "center", justifyContent: "center" },
  closeGlass: {
    width: 70,
    height: 40,
    borderRadius: 20,
    overflow: "hidden",
  },
  closeButton: { flex: 1, alignItems: "center", justifyContent: "center" },
  closeLabel: { color: "#050505", fontSize: 16, lineHeight: 21, fontWeight: "500" },
  pressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  stageWithCaption: { marginBottom: 68 },
  image: { width: "100%", height: "100%" },
  loader: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  imageError: {
    position: "absolute",
    alignItems: "center",
    gap: 16,
    padding: 24,
    backgroundColor: "#000",
  },
  errorLabel: { color: "#fff", fontSize: 16, textAlign: "center" },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: "#333",
  },
  caption: {
    position: "absolute",
    left: 28,
    right: 28,
    bottom: 44,
    color: "rgba(255,255,255,0.72)",
    fontSize: 13.5,
    lineHeight: 18,
    fontWeight: "400",
    textAlign: "center",
  },
});
