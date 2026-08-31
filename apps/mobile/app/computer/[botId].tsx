import type { ScreenActionInput, ScreenStatusView } from "@openbot/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GlassSurface } from "../../src/components/glass-surface";
import { IconButton } from "../../src/components/icon-button";
import { useOpenBot } from "../../src/state/openbot-context";
import { useTheme } from "../../src/theme";
import { authHeadersForUrl } from "../../src/auth";

type ScreenApp = ScreenStatusView["apps"][number];

const appDetails: Record<ScreenApp, { label: string; icon: SymbolViewProps["name"] }> = {
  chromium: { label: "Browser", icon: "safari" },
  terminal: { label: "Terminal", icon: "apple.terminal" },
  thunar: { label: "Files", icon: "folder" },
};

function FixtureDesktop({ dark }: { dark: boolean }) {
  return (
    <View style={[styles.fixtureDesktop, { backgroundColor: dark ? "#121212" : "#ECECE8" }]}>
      <View style={[styles.fixtureBar, { backgroundColor: dark ? "#252523" : "#D8D8D3" }]}>
        <View style={[styles.fixtureDot, { backgroundColor: "#F06B5E" }]} />
        <View style={[styles.fixtureDot, { backgroundColor: "#E6B04B" }]} />
        <View style={[styles.fixtureDot, { backgroundColor: "#52B267" }]} />
        <View style={[styles.fixtureAddress, { backgroundColor: dark ? "#343431" : "#F6F6F3" }]} />
      </View>
      <View style={styles.fixtureContent}>
        <View style={[styles.fixtureSidebar, { backgroundColor: dark ? "#1C1C1A" : "#E2E2DE" }]} />
        <View style={styles.fixtureMain}>
          <View
            style={[styles.fixtureHeading, { backgroundColor: dark ? "#555550" : "#B5B5AF" }]}
          />
          <View style={styles.fixtureCards}>
            <View style={[styles.fixtureCard, { backgroundColor: dark ? "#292927" : "#FFFFFF" }]} />
            <View style={[styles.fixtureCard, { backgroundColor: dark ? "#292927" : "#FFFFFF" }]} />
          </View>
          <Text style={[styles.fixtureLabel, { color: dark ? "#92928D" : "#6F6F6A" }]}>
            Preview computer
          </Text>
        </View>
      </View>
    </View>
  );
}

function AppControl({
  app,
  disabled,
  onPress,
}: {
  app: ScreenApp;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const details = appDetails[app];
  return (
    <Pressable
      accessibilityLabel={`Open ${details.label}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.appHit, { opacity: disabled ? 0.4 : pressed ? 0.66 : 1 }]}
    >
      <GlassSurface
        fallbackColor={theme.surfaceElevated}
        interactive
        style={[styles.appPill, { borderColor: theme.border }]}
      >
        <SymbolView name={details.icon} size={15} tintColor={theme.textMuted} />
        <Text style={[styles.appLabel, { color: theme.text }]}>{details.label}</Text>
      </GlassSurface>
    </Pressable>
  );
}

export default function ComputerScreen() {
  const theme = useTheme();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const { isFixture, screenAction, screenFrameUrl, screenStatus, setScreenTakeover, snapshot } =
    useOpenBot();
  const bot = snapshot.bots.find((candidate) => candidate.id === botId);
  const [status, setStatus] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [typing, setTyping] = useState("");
  const [busy, setBusy] = useState(false);
  const tookControl = useRef(false);

  const refresh = useCallback(async () => {
    if (!botId) return;
    try {
      const next = await screenStatus(botId);
      setStatus(next);
      setFrameRevision(Date.now());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the shared computer");
    }
  }, [botId, screenStatus]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 2500);
    return () => {
      clearInterval(poll);
      if (botId && tookControl.current) void setScreenTakeover(botId, false);
    };
  }, [botId, refresh, setScreenTakeover]);

  const act = async (input: ScreenActionInput) => {
    if (!botId || busy || !status?.humanTakeover) return;
    setBusy(true);
    try {
      setStatus(await screenAction(botId, input));
      setFrameRevision(Date.now());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The computer action failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleTakeover = async () => {
    if (!botId || busy) return;
    setBusy(true);
    try {
      const active = !status?.humanTakeover;
      const next = await setScreenTakeover(botId, active);
      tookControl.current = active;
      setStatus(next);
      setFrameRevision(Date.now());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change computer control");
    } finally {
      setBusy(false);
    }
  };

  const frameUrl = botId ? screenFrameUrl(botId, frameRevision) : null;
  const ready = status?.state === "ready";
  const controlling = Boolean(status?.humanTakeover);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Close shared computer"
          name="xmark"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          size={38}
          symbolSize={15}
          tone="surface"
        />
        <GlassSurface
          fallbackColor={theme.surfaceElevated}
          style={[styles.titlePill, { borderColor: theme.border }]}
        >
          <View
            style={[styles.liveDot, { backgroundColor: ready ? theme.success : theme.textFaint }]}
          />
          <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
            {bot?.name ?? "OpenBot"} computer
          </Text>
        </GlassSurface>
        <IconButton
          label="Refresh computer"
          name="arrow.clockwise"
          onPress={() => void refresh()}
          size={38}
          symbolSize={16}
          tone="surface"
        />
      </View>

      <View style={styles.content}>
        <View
          style={[
            styles.screenShell,
            {
              aspectRatio: status ? status.width / status.height : 1.6,
              backgroundColor: theme.dark ? "#111110" : "#E8E8E4",
              borderColor: theme.border,
            },
          ]}
          onLayout={(event) => setFrameSize(event.nativeEvent.layout)}
        >
          {!status && !error ? (
            <ActivityIndicator color={theme.textMuted} />
          ) : isFixture ? (
            <Pressable
              accessibilityLabel={controlling ? "Tap the preview computer" : "Computer preview"}
              disabled={!controlling}
              onPress={(event) => {
                if (!status) return;
                const x = Math.round(
                  (event.nativeEvent.locationX / frameSize.width) * status.width
                );
                const y = Math.round(
                  (event.nativeEvent.locationY / frameSize.height) * status.height
                );
                void act({ action: "click", x, y });
              }}
              style={styles.frame}
            >
              <FixtureDesktop dark={theme.dark} />
            </Pressable>
          ) : frameUrl && ready ? (
            <Pressable
              accessibilityLabel={controlling ? "Tap the shared computer" : "Shared computer"}
              disabled={!controlling}
              onPress={(event) => {
                if (!status) return;
                const x = Math.round(
                  (event.nativeEvent.locationX / frameSize.width) * status.width
                );
                const y = Math.round(
                  (event.nativeEvent.locationY / frameSize.height) * status.height
                );
                void act({ action: "click", x, y });
              }}
              style={styles.frame}
            >
              <Image
                onError={() => setError("The latest computer frame could not be loaded")}
                resizeMode="contain"
                source={{ uri: frameUrl, headers: authHeadersForUrl(frameUrl) }}
                style={styles.frame}
              />
            </Pressable>
          ) : (
            <View style={styles.centerState}>
              <SymbolView name="desktopcomputer" size={28} tintColor={theme.textFaint} />
              <Text style={[styles.stateCopy, { color: theme.textMuted }]}>
                Computer unavailable
              </Text>
            </View>
          )}
          {busy ? (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : null}
        </View>

        <Text style={[styles.help, { color: error ? theme.danger : theme.textMuted }]}>
          {error ??
            (controlling
              ? "You have control. Tap the screen, type, scroll, or open an app."
              : "Watch live, or take control when the agent needs your help.")}
        </Text>

        <View style={styles.apps}>
          {(status?.apps ?? ["chromium", "thunar", "terminal"]).map((app) => (
            <AppControl
              app={app}
              disabled={!controlling || busy}
              key={app}
              onPress={() => void act({ action: "open_app", app })}
            />
          ))}
        </View>

        <GlassSurface
          fallbackColor={theme.surfaceElevated}
          style={[styles.controlPanel, { borderColor: theme.border }]}
        >
          <View style={styles.typeRow}>
            <TextInput
              accessibilityLabel="Type on shared computer"
              editable={controlling && !busy}
              onChangeText={setTyping}
              onSubmitEditing={() => {
                const text = typing;
                if (!text) return;
                setTyping("");
                void act({ action: "type", text });
              }}
              placeholder={controlling ? "Type on computer" : "Take control to type"}
              placeholderTextColor={theme.textFaint}
              returnKeyType="send"
              style={[styles.typeInput, { color: theme.text }]}
              value={typing}
            />
            <IconButton
              disabled={!controlling || !typing || busy}
              label="Send text to computer"
              name="arrow.up"
              onPress={() => {
                const text = typing;
                setTyping("");
                void act({ action: "type", text });
              }}
              size={34}
              symbolSize={16}
              tone="dark"
            />
          </View>
          <View style={[styles.panelDivider, { backgroundColor: theme.separator }]} />
          <View style={styles.controlRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !ready}
              onPress={() => void toggleTakeover()}
              style={({ pressed }) => [
                styles.takeover,
                {
                  backgroundColor: controlling ? theme.surfacePressed : theme.text,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <SymbolView
                name={controlling ? "hand.raised.fill" : "hand.tap.fill"}
                size={16}
                tintColor={controlling ? theme.text : theme.background}
              />
              <Text
                style={[
                  styles.takeoverLabel,
                  { color: controlling ? theme.text : theme.background },
                ]}
              >
                {controlling ? "Return control" : "Take control"}
              </Text>
            </Pressable>
            <View style={styles.scrollControls}>
              <IconButton
                disabled={!controlling || busy}
                label="Scroll up"
                name="chevron.up"
                onPress={() => void act({ action: "scroll", deltaY: -6 })}
                size={34}
                symbolSize={14}
                tone="subtle"
              />
              <IconButton
                disabled={!controlling || busy}
                label="Scroll down"
                name="chevron.down"
                onPress={() => void act({ action: "scroll", deltaY: 6 })}
                size={34}
                symbolSize={14}
                tone="subtle"
              />
            </View>
          </View>
        </GlassSurface>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    height: 58,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  titlePill: {
    maxWidth: 230,
    minHeight: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    overflow: "hidden",
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  title: { flexShrink: 1, fontSize: 15, lineHeight: 19, fontWeight: "600" },
  content: { flex: 1, paddingHorizontal: 14, paddingTop: 13, paddingBottom: 10 },
  screenShell: {
    width: "100%",
    maxHeight: 420,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 7 },
  },
  frame: { width: "100%", height: "100%" },
  busyOverlay: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.24)",
  },
  centerState: { alignItems: "center", gap: 8 },
  stateCopy: { fontSize: 14, lineHeight: 19 },
  help: { minHeight: 39, paddingHorizontal: 5, paddingTop: 10, fontSize: 12, lineHeight: 17 },
  apps: { flexDirection: "row", gap: 7, paddingBottom: 10 },
  appHit: { flex: 1 },
  appPill: {
    minHeight: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    overflow: "hidden",
  },
  appLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  controlPanel: {
    marginTop: "auto",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 7,
    overflow: "hidden",
  },
  typeRow: { minHeight: 42, flexDirection: "row", alignItems: "center", paddingLeft: 9 },
  typeInput: { flex: 1, height: 40, paddingVertical: 0, fontSize: 15, lineHeight: 20 },
  panelDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 7 },
  controlRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 3,
  },
  takeover: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  takeoverLabel: { fontSize: 13, lineHeight: 17, fontWeight: "700" },
  scrollControls: { flexDirection: "row", gap: 1 },
  fixtureDesktop: { flex: 1 },
  fixtureBar: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
  },
  fixtureDot: { width: 7, height: 7, borderRadius: 4 },
  fixtureAddress: { flex: 1, height: 14, marginLeft: 5, borderRadius: 7 },
  fixtureContent: { flex: 1, flexDirection: "row", padding: 8, gap: 8 },
  fixtureSidebar: { width: "22%", borderRadius: 6 },
  fixtureMain: { flex: 1, padding: 9 },
  fixtureHeading: { width: "45%", height: 9, borderRadius: 5 },
  fixtureCards: { flexDirection: "row", gap: 8, marginTop: 12 },
  fixtureCard: { flex: 1, height: 76, borderRadius: 8 },
  fixtureLabel: { marginTop: 10, fontSize: 10, lineHeight: 13, fontWeight: "600" },
});
