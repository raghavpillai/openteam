import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
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
import { SafeAreaView } from "react-native-safe-area-context";
import { GlassSurface } from "./glass-surface";

export interface ImageViewerItem {
  caption: string;
  uri: string;
}

export function ImageViewer({
  item,
  onClose,
}: {
  item: ImageViewerItem | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);

  const close = () => {
    void Haptics.selectionAsync();
    onClose();
  };

  const share = async () => {
    if (!item) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await Share.share({ message: item.caption, url: item.uri });
    } catch {
      Alert.alert("Couldn’t Share", "This image could not be shared right now.");
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
              hitSlop={8}
              onPress={() => void share()}
              style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}
            >
              <SymbolView
                name="square.and.arrow.down"
                size={22}
                tintColor="#050505"
                weight="medium"
              />
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

        <View style={[styles.stage, item?.caption ? styles.stageWithCaption : null]}>
          {item ? (
            <Image
              accessibilityLabel={item.caption}
              onLoadEnd={() => setLoading(false)}
              onLoadStart={() => setLoading(true)}
              resizeMode="contain"
              source={{ uri: item.uri }}
              style={styles.image}
            />
          ) : null}
          {loading && item ? (
            <ActivityIndicator color="rgba(255,255,255,0.72)" size="small" style={styles.loader} />
          ) : null}
        </View>

        {item?.caption ? (
          <Text accessibilityRole="text" numberOfLines={3} style={styles.caption}>
            {item.caption}
          </Text>
        ) : null}
      </SafeAreaView>
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
    transform: [{ translateY: -17 }],
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
