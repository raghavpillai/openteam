import {
  createScreenSessionController,
  type ScreenSessionController,
} from "@openbot/client-core/screen";
import type { ScreenActionInput, ScreenStatusView } from "@openbot/contracts";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { authHeadersForUrl } from "../../src/auth";
import { BotMark } from "../../src/components/bot-mark";
import { useOpenBot } from "../../src/state/openbot-context";

type ScreenApp = ScreenStatusView["apps"][number];

const appDetails: Record<ScreenApp, { label: string; icon: SymbolViewProps["name"] }> = {
  chromium: { label: "Browser", icon: "safari" },
  terminal: { label: "Terminal", icon: "apple.terminal" },
  thunar: { label: "Files", icon: "folder" },
};

function FixtureDesktop() {
  return (
    <View style={styles.fixtureDesktop}>
      <View style={styles.fixtureWindow}>
        <View style={styles.fixtureBar}>
          <View style={[styles.fixtureDot, { backgroundColor: "#FF5F57" }]} />
          <View style={[styles.fixtureDot, { backgroundColor: "#FEBC2E" }]} />
          <View style={[styles.fixtureDot, { backgroundColor: "#28C840" }]} />
          <View style={styles.fixtureAddress}>
            <Text style={styles.fixtureAddressText}>openbot.local</Text>
          </View>
        </View>
        <View style={styles.fixtureContent}>
          <Text style={styles.fixtureHeading}>Sign in to OpenBot</Text>
          <View style={styles.fixtureField}>
            <Text style={styles.fixtureFieldText}>you@example.com</Text>
          </View>
          <View style={styles.fixtureField}>
            <Text style={styles.fixturePassword}>••••••••••</Text>
          </View>
          <View style={styles.fixtureSubmit}>
            <Text style={styles.fixtureSubmitText}>Sign in</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function StageButton({
  active = false,
  disabled = false,
  label,
  name,
  onPress,
  size = 48,
  symbolSize = 19,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  name: SymbolViewProps["name"];
  onPress: () => void;
  size?: number;
  symbolSize?: number;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={5}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.stageButtonHit,
        { height: Math.max(44, size), width: Math.max(44, size) },
        pressed && styles.stageButtonPressed,
        disabled && styles.disabled,
      ]}
    >
      <View
        style={[
          styles.stageButton,
          { borderRadius: size / 2, height: size, width: size },
          active && styles.stageButtonActive,
        ]}
      >
        <SymbolView
          name={name}
          size={symbolSize}
          tintColor={active ? "#111111" : "#F7F7F4"}
          weight="medium"
        />
      </View>
    </Pressable>
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
  const details = appDetails[app];
  return (
    <Pressable
      accessibilityLabel={`Open ${details.label}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.appHit, { opacity: disabled ? 0.4 : pressed ? 0.66 : 1 }]}
    >
      <View style={styles.appPill}>
        <SymbolView name={details.icon} size={15} tintColor="#B9B9B5" />
        <Text style={styles.appLabel}>{details.label}</Text>
      </View>
    </Pressable>
  );
}

export default function ComputerScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const { isFixture, screenAction, screenFrameUrl, screenStatus, setScreenTakeover, snapshot } =
    useOpenBot();
  const bot = snapshot.bots.find((candidate) => candidate.id === botId);
  const [status, setStatus] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [typing, setTyping] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const takeoverActive = useRef(false);
  const refreshEpoch = useRef(0);
  const statusRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const screenSession = useRef<ScreenSessionController | null>(null);
  const inputRef = useRef<TextInput>(null);
  const busy = actionBusy || takeoverBusy;

  const refresh = useCallback(async () => {
    if (!botId || refreshInFlight.current || AppState.currentState !== "active") return;
    const epoch = refreshEpoch.current;
    const revision = statusRevision.current;
    refreshInFlight.current = true;
    try {
      const next = await screenStatus(botId);
      if (epoch !== refreshEpoch.current || revision !== statusRevision.current) return;
      takeoverActive.current = next.humanTakeover;
      screenSession.current?.confirmTakeover(next.humanTakeover);
      setStatus(next);
      setFrameRevision(Date.now());
      setError(null);
    } catch (cause) {
      if (epoch !== refreshEpoch.current || revision !== statusRevision.current) return;
      setError(clientErrorMessage(cause, "Could not open the shared computer"));
    } finally {
      refreshInFlight.current = false;
    }
  }, [botId, screenStatus]);

  useFocusEffect(
    useCallback(() => {
      setActionBusy(false);
      setTakeoverBusy(false);
      const controller = createScreenSessionController({
        pollIntervalMs: 2_500,
        pollStatus: refresh,
        requestTakeover: (active) => setScreenTakeover(botId, active),
        onTakeoverBusyChange: setTakeoverBusy,
        onError: (cause) =>
          setError(clientErrorMessage(cause, "Could not change computer control")),
        onTakeoverResult: (next) => {
          statusRevision.current += 1;
          takeoverActive.current = next.humanTakeover;
          setStatus(next);
          setFrameRevision(Date.now());
          setError(null);
        },
      });
      screenSession.current = controller;
      const appStateSubscription = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          controller.activate();
          controller.wake();
          return;
        }
        refreshEpoch.current += 1;
        statusRevision.current += 1;
        controller.deactivate();
        takeoverActive.current = false;
      });
      if (AppState.currentState === "active") controller.activate();
      else controller.deactivate();
      return () => {
        appStateSubscription.remove();
        refreshEpoch.current += 1;
        statusRevision.current += 1;
        controller.stop();
        if (screenSession.current === controller) screenSession.current = null;
        takeoverActive.current = false;
      };
    }, [botId, refresh, setScreenTakeover])
  );

  useEffect(() => {
    return () => {
      refreshEpoch.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!keyboardOpen || !status?.humanTakeover) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [keyboardOpen, status?.humanTakeover]);

  const act = async (input: ScreenActionInput) => {
    if (!botId || busy || !status?.humanTakeover) return;
    const epoch = refreshEpoch.current;
    const revision = statusRevision.current + 1;
    statusRevision.current = revision;
    setActionBusy(true);
    try {
      const next = await screenAction(botId, input);
      if (epoch !== refreshEpoch.current || revision !== statusRevision.current) return;
      statusRevision.current += 1;
      setStatus(next);
      setFrameRevision(Date.now());
      setError(null);
    } catch (cause) {
      if (epoch !== refreshEpoch.current || revision !== statusRevision.current) return;
      setError(clientErrorMessage(cause, "The computer action failed"));
    } finally {
      if (epoch === refreshEpoch.current) setActionBusy(false);
    }
  };

  const changeTakeover = (active: boolean) => {
    if (!botId) return;
    statusRevision.current += 1;
    screenSession.current?.setTakeover(active);
  };

  const toggleTakeover = () => changeTakeover(!takeoverActive.current);

  const openKeyboard = () => {
    setControlsOpen(false);
    setKeyboardOpen(true);
    if (ready && !controlling) void changeTakeover(true);
  };

  const closeKeyboard = () => {
    setKeyboardOpen(false);
    Keyboard.dismiss();
  };

  const frameUrl = botId ? screenFrameUrl(botId, frameRevision) : null;
  const ready = status?.state === "ready";
  const controlling = Boolean(status?.humanTakeover);
  const aspectRatio =
    status && status.width > 0 && status.height > 0 ? status.width / status.height : 1.6;

  const sendTypedText = () => {
    const text = typing;
    if (!text || !controlling) return;
    setTyping("");
    void act({ action: "type", text });
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <StageButton
          label="Back to conversation"
          name="chevron.left"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          symbolSize={20}
        />
        <View style={styles.titlePill}>
          <BotMark color={bot?.color ?? "#8057F5"} icon={bot?.icon} size={34} />
          <Text numberOfLines={1} style={styles.title}>
            {bot?.name ?? "OpenBot"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <StageButton
            active={keyboardOpen}
            disabled={!ready}
            label="Type on computer"
            name="keyboard"
            onPress={() => (keyboardOpen ? closeKeyboard() : openKeyboard())}
          />
          <StageButton
            active={controlsOpen}
            label="Computer controls"
            name="ellipsis"
            onPress={() => {
              closeKeyboard();
              setControlsOpen((current) => !current);
            }}
            symbolSize={21}
          />
        </View>
      </View>

      <View style={styles.stage}>
        <View
          style={[styles.screenShell, { aspectRatio }]}
          onLayout={(event) => setFrameSize(event.nativeEvent.layout)}
        >
          {!status && !error ? (
            <ActivityIndicator color="#92928D" />
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
              <FixtureDesktop />
            </Pressable>
          ) : frameUrl && ready ? (
            <View style={styles.frame}>
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
                  onError={() => setFrameError("The latest computer frame could not be loaded")}
                  onLoad={() => setFrameError(null)}
                  resizeMode="contain"
                  source={{ uri: frameUrl, headers: authHeadersForUrl(frameUrl) }}
                  style={styles.frame}
                />
              </Pressable>
              {frameError ? (
                <View pointerEvents="none" style={[styles.centerState, styles.frameErrorOverlay]}>
                  <SymbolView name="exclamationmark.triangle" size={28} tintColor="#777773" />
                  <Text style={styles.stateCopy}>{frameError}</Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.centerState}>
              <SymbolView name="desktopcomputer" size={28} tintColor="#777773" />
              <Text style={styles.stateCopy}>{error ?? "Computer unavailable"}</Text>
            </View>
          )}
          {busy ? (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : null}
        </View>
      </View>

      {controlsOpen ? (
        <View style={styles.controlTray}>
          <View style={styles.trayHeadingRow}>
            <View>
              <Text style={styles.trayTitle}>Computer controls</Text>
              <Text style={[styles.trayStatus, error && styles.trayError]}>
                {error ??
                  frameError ??
                  (controlling ? "You have control" : ready ? "Watching live" : "Connecting…")}
              </Text>
            </View>
            <StageButton
              label="Refresh computer"
              name="arrow.clockwise"
              onPress={() => void refresh()}
              size={38}
              symbolSize={15}
            />
          </View>
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
          <View style={styles.controlRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !ready}
              onPress={toggleTakeover}
              style={({ pressed }) => [
                styles.takeover,
                controlling && styles.takeoverControlling,
                pressed && styles.takeoverPressed,
                (busy || !ready) && styles.disabled,
              ]}
            >
              <SymbolView
                name={controlling ? "hand.raised.fill" : "hand.tap.fill"}
                size={16}
                tintColor={controlling ? "#F7F7F4" : "#111111"}
              />
              <Text style={[styles.takeoverLabel, controlling && styles.takeoverLabelControlling]}>
                {controlling ? "Return control" : "Take control"}
              </Text>
            </Pressable>
            <View style={styles.scrollControls}>
              <StageButton
                disabled={!controlling || busy}
                label="Scroll up"
                name="chevron.up"
                onPress={() => void act({ action: "scroll", deltaY: -6 })}
                size={38}
                symbolSize={14}
              />
              <StageButton
                disabled={!controlling || busy}
                label="Scroll down"
                name="chevron.down"
                onPress={() => void act({ action: "scroll", deltaY: 6 })}
                size={38}
                symbolSize={14}
              />
            </View>
          </View>
        </View>
      ) : null}

      {keyboardOpen ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          pointerEvents="box-none"
          style={styles.keyboardLayer}
        >
          <View style={styles.keyboardDock}>
            <StageButton
              label="Close keyboard"
              name="chevron.down"
              onPress={closeKeyboard}
              size={38}
              symbolSize={14}
            />
            <TextInput
              accessibilityLabel="Type on shared computer"
              editable={controlling && !busy}
              onChangeText={setTyping}
              onSubmitEditing={sendTypedText}
              placeholder={controlling ? "Type on computer" : "Taking control…"}
              placeholderTextColor="#777773"
              ref={inputRef}
              returnKeyType="send"
              style={styles.typeInput}
              value={typing}
            />
            <StageButton
              active={Boolean(controlling && typing)}
              disabled={!controlling || !typing || busy}
              label="Send text to computer"
              name="arrow.up"
              onPress={sendTypedText}
              size={38}
              symbolSize={16}
            />
          </View>
        </KeyboardAvoidingView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000000" },
  header: {
    minHeight: 66,
    paddingHorizontal: 14,
    paddingTop: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  stageButtonHit: { alignItems: "center", justifyContent: "center" },
  stageButton: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.09)",
    backgroundColor: "#292929",
  },
  stageButtonActive: { backgroundColor: "#F7F7F4", borderColor: "#F7F7F4" },
  stageButtonPressed: { opacity: 0.72, transform: [{ scale: 0.95 }] },
  disabled: { opacity: 0.34 },
  titlePill: {
    minWidth: 0,
    maxWidth: 188,
    height: 48,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.09)",
    backgroundColor: "#292929",
    paddingLeft: 7,
    paddingRight: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    overflow: "hidden",
  },
  title: {
    flexShrink: 1,
    color: "#F7F7F4",
    fontSize: 17,
    lineHeight: 21,
    fontWeight: "600",
  },
  headerActions: { marginLeft: "auto", flexDirection: "row", gap: 8 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  screenShell: {
    width: "100%",
    maxHeight: 560,
    backgroundColor: "#151515",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
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
  frameErrorOverlay: {
    position: "absolute",
    inset: 0,
    justifyContent: "center",
    backgroundColor: "#151515",
  },
  stateCopy: { color: "#92928D", fontSize: 13, lineHeight: 18 },
  controlTray: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 14,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(28,28,27,0.97)",
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.48,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  trayHeadingRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 4,
  },
  trayTitle: { color: "#F7F7F4", fontSize: 15, lineHeight: 19, fontWeight: "700" },
  trayStatus: { marginTop: 2, color: "#92928D", fontSize: 12, lineHeight: 16 },
  trayError: { color: "#FF777C" },
  apps: { flexDirection: "row", gap: 7, paddingVertical: 12 },
  appHit: { flex: 1 },
  appPill: {
    minHeight: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "#292929",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    overflow: "hidden",
  },
  appLabel: { color: "#F7F7F4", fontSize: 12, lineHeight: 16, fontWeight: "600" },
  controlRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  takeover: {
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#F7F7F4",
  },
  takeoverControlling: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "#292929",
  },
  takeoverPressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  takeoverLabel: { color: "#111111", fontSize: 13, lineHeight: 17, fontWeight: "700" },
  takeoverLabelControlling: { color: "#F7F7F4" },
  scrollControls: { flexDirection: "row", gap: 4 },
  keyboardLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "flex-end",
  },
  keyboardDock: {
    minHeight: 64,
    marginHorizontal: 14,
    marginBottom: 10,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(28,28,27,0.98)",
    padding: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  typeInput: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#292929",
    color: "#F7F7F4",
    paddingHorizontal: 16,
    paddingVertical: 0,
    fontSize: 15,
    lineHeight: 20,
  },
  fixtureDesktop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#8A8A8A",
  },
  fixtureWindow: {
    width: "64%",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 7 },
  },
  fixtureBar: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    backgroundColor: "#E7E7E5",
  },
  fixtureDot: { width: 6, height: 6, borderRadius: 3 },
  fixtureAddress: {
    flex: 1,
    height: 14,
    marginHorizontal: 5,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  fixtureAddressText: { color: "#686866", fontSize: 6, lineHeight: 8 },
  fixtureContent: { paddingHorizontal: 22, paddingBottom: 14, paddingTop: 12 },
  fixtureHeading: {
    marginBottom: 10,
    color: "#191919",
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  fixtureField: {
    height: 22,
    marginBottom: 7,
    borderRadius: 6,
    backgroundColor: "#F0F0F0",
    justifyContent: "center",
    paddingHorizontal: 9,
  },
  fixtureFieldText: { color: "#292929", fontSize: 7, lineHeight: 9 },
  fixturePassword: { color: "#686866", fontSize: 7, lineHeight: 9, letterSpacing: 0.3 },
  fixtureSubmit: {
    height: 23,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#18181C",
  },
  fixtureSubmitText: { color: "#FFFFFF", fontSize: 7, lineHeight: 9, fontWeight: "700" },
});
