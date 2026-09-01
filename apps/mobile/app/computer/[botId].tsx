import {
  createScreenSessionController,
  type ScreenSessionController,
} from "@openbot/client-core/screen";
import type { ScreenActionInput, ScreenStatusView } from "@openbot/contracts";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
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
import { ComputerHelpSheet } from "../../src/components/computer-help-sheet";
import { useOpenBot } from "../../src/state/openbot-context";

type ScreenApp = ScreenStatusView["apps"][number];

const touchDistance = (touches: ReadonlyArray<{ pageX: number; pageY: number }>) => {
  const [first, second] = touches;
  if (!first || !second) return 0;
  return Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
};

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
  size = 38,
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [trackpadMode, setTrackpadMode] = useState(false);
  const [screenZoom, setScreenZoom] = useState(1);
  const [modeToast, setModeToast] = useState<string | null>(null);
  const takeoverActive = useRef(false);
  const refreshEpoch = useRef(0);
  const statusRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const screenSession = useRef<ScreenSessionController | null>(null);
  const inputRef = useRef<TextInput>(null);
  const actionTail = useRef<Promise<void>>(Promise.resolve());
  const pendingActions = useRef(0);
  const keyboardValue = useRef("");
  const keyboardBuffer = useRef("");
  const keyboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef({ x: 640, y: 400 });
  const zoomRef = useRef(1);
  const lastTapAt = useRef(0);
  const gesture = useRef({
    startedAt: 0,
    touches: 1,
    startDistance: 0,
    startZoom: 1,
    startPoint: { x: 640, y: 400 },
    pointerStart: { x: 640, y: 400 },
    path: [] as Array<{ x: number; y: number }>,
    pinching: false,
    trackpadDrag: false,
  });
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
      if (keyboardTimer.current) clearTimeout(keyboardTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!keyboardOpen || status?.state !== "ready") return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [keyboardOpen, status?.state]);

  useEffect(() => {
    zoomRef.current = screenZoom;
  }, [screenZoom]);

  const performAction = useCallback(
    async (input: ScreenActionInput) => {
      if (!botId || !takeoverActive.current) return;
      const epoch = refreshEpoch.current;
      const revision = statusRevision.current + 1;
      statusRevision.current = revision;
      pendingActions.current += 1;
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
        pendingActions.current = Math.max(0, pendingActions.current - 1);
        if (epoch === refreshEpoch.current && pendingActions.current === 0) setActionBusy(false);
      }
    },
    [botId, screenAction]
  );

  const act = useCallback(
    (input: ScreenActionInput): Promise<void> => {
      const next = actionTail.current.catch(() => undefined).then(() => performAction(input));
      actionTail.current = next;
      return next;
    },
    [performAction]
  );

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

  const flushKeyboardBuffer = useCallback(() => {
    if (keyboardTimer.current) {
      clearTimeout(keyboardTimer.current);
      keyboardTimer.current = null;
    }
    const text = keyboardBuffer.current;
    if (text && !takeoverActive.current) {
      keyboardTimer.current = setTimeout(flushKeyboardBuffer, 150);
      return;
    }
    keyboardBuffer.current = "";
    if (text) void act({ action: "type", text });
  }, [act]);

  const handleKeyboardChange = useCallback(
    (value: string) => {
      const previous = keyboardValue.current;
      keyboardValue.current = value;
      setTyping(value);
      if (value.startsWith(previous) && value.length > previous.length) {
        keyboardBuffer.current += value.slice(previous.length);
        if (keyboardTimer.current) clearTimeout(keyboardTimer.current);
        keyboardTimer.current = setTimeout(flushKeyboardBuffer, 90);
        return;
      }
      flushKeyboardBuffer();
      let commonLength = 0;
      while (
        commonLength < previous.length &&
        commonLength < value.length &&
        previous[commonLength] === value[commonLength]
      ) {
        commonLength += 1;
      }
      const deletedCount = previous.length - commonLength;
      for (let offset = 0; offset < deletedCount; offset += 12) {
        const count = Math.min(12, deletedCount - offset);
        void act({ action: "key", keys: Array.from({ length: count }, () => "BackSpace") });
      }
      const inserted = value.slice(commonLength);
      if (inserted) void act({ action: "type", text: inserted });
    },
    [act, flushKeyboardBuffer]
  );

  const submitKeyboard = useCallback(() => {
    flushKeyboardBuffer();
    void act({ action: "key", keys: ["Return"] });
    keyboardValue.current = "";
    setTyping("");
  }, [act, flushKeyboardBuffer]);

  const remotePoint = useCallback(
    (localX: number, localY: number) => {
      const width = Math.max(1, frameSize.width);
      const height = Math.max(1, frameSize.height);
      const zoom = zoomRef.current;
      const normalizedX = ((localX - width / 2) / zoom + width / 2) / width;
      const normalizedY = ((localY - height / 2) / zoom + height / 2) / height;
      return {
        x: Math.max(
          0,
          Math.min((status?.width ?? 1280) - 1, Math.round(normalizedX * (status?.width ?? 1280)))
        ),
        y: Math.max(
          0,
          Math.min((status?.height ?? 800) - 1, Math.round(normalizedY * (status?.height ?? 800)))
        ),
      };
    },
    [frameSize.height, frameSize.width, status?.height, status?.width]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => controlling,
        onMoveShouldSetPanResponder: () => controlling,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          const startPoint = remotePoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
          const startedAt = Date.now();
          gesture.current = {
            startedAt,
            touches: Math.max(1, touches.length),
            startDistance: touchDistance(touches),
            startZoom: zoomRef.current,
            startPoint,
            pointerStart: { ...pointer.current },
            path: [startPoint],
            pinching: false,
            trackpadDrag: trackpadMode && startedAt - lastTapAt.current < 320,
          };
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          gesture.current.touches = Math.max(gesture.current.touches, touches.length);
          if (touches.length >= 2) {
            const distance = touchDistance(touches);
            if (gesture.current.startDistance <= 0) {
              gesture.current.startDistance = distance;
              gesture.current.startZoom = zoomRef.current;
              return;
            }
            const ratio = distance / gesture.current.startDistance;
            if (Math.abs(ratio - 1) > 0.04 || gesture.current.pinching) {
              gesture.current.pinching = true;
              const nextZoom = Math.max(1, Math.min(3, gesture.current.startZoom * ratio));
              zoomRef.current = nextZoom;
              setScreenZoom(nextZoom);
            }
            return;
          }
          if (trackpadMode) {
            const width = Math.max(1, frameSize.width);
            const height = Math.max(1, frameSize.height);
            pointer.current = {
              x: Math.max(
                0,
                Math.min(
                  (status?.width ?? 1280) - 1,
                  Math.round(
                    gesture.current.pointerStart.x +
                      (state.dx / width) * (status?.width ?? 1280) * 1.65
                  )
                )
              ),
              y: Math.max(
                0,
                Math.min(
                  (status?.height ?? 800) - 1,
                  Math.round(
                    gesture.current.pointerStart.y +
                      (state.dy / height) * (status?.height ?? 800) * 1.65
                  )
                )
              ),
            };
            return;
          }
          if (gesture.current.path.length < 100) {
            const nextPoint = remotePoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
            const previous = gesture.current.path.at(-1);
            if (!previous || Math.hypot(nextPoint.x - previous.x, nextPoint.y - previous.y) > 5) {
              gesture.current.path.push(nextPoint);
            }
          }
        },
        onPanResponderRelease: (_event, state) => {
          if (gesture.current.pinching) return;
          const distance = Math.hypot(state.dx, state.dy);
          const held = Date.now() - gesture.current.startedAt;
          if (gesture.current.touches >= 2) {
            if (distance < 10) {
              void act({ action: "click", ...gesture.current.startPoint, button: "right" });
            } else if (zoomRef.current <= 1.01) {
              const deltaY = Math.max(-20, Math.min(20, Math.round(state.dy / 18)));
              if (deltaY) void act({ action: "scroll", deltaY });
            }
            return;
          }
          if (trackpadMode) {
            if (distance >= 4) {
              void act(
                gesture.current.trackpadDrag
                  ? {
                      action: "drag",
                      path: [gesture.current.pointerStart, { ...pointer.current }],
                    }
                  : { action: "move", ...pointer.current }
              );
            }
            if (distance < 10) {
              const now = Date.now();
              const double = now - lastTapAt.current < 320;
              lastTapAt.current = now;
              void act({
                action: "click",
                ...pointer.current,
                ...(double ? { double: true } : {}),
              });
            }
            return;
          }
          if (distance < 10) {
            const now = Date.now();
            const double = now - lastTapAt.current < 320;
            lastTapAt.current = now;
            void act({
              action: "click",
              ...gesture.current.startPoint,
              ...(held >= 550 ? { button: "right" as const } : double ? { double: true } : {}),
            });
            return;
          }
          const lastPoint = gesture.current.path.at(-1);
          const end =
            lastPoint && gesture.current.path.length > 1
              ? lastPoint
              : {
                  x: Math.max(
                    0,
                    Math.min(
                      (status?.width ?? 1280) - 1,
                      Math.round(
                        gesture.current.startPoint.x +
                          ((state.dx / Math.max(1, frameSize.width)) * (status?.width ?? 1280)) /
                            zoomRef.current
                      )
                    )
                  ),
                  y: Math.max(
                    0,
                    Math.min(
                      (status?.height ?? 800) - 1,
                      Math.round(
                        gesture.current.startPoint.y +
                          ((state.dy / Math.max(1, frameSize.height)) * (status?.height ?? 800)) /
                            zoomRef.current
                      )
                    )
                  ),
                };
          const path = [...gesture.current.path, end].filter((point, index, points) => {
            const previous = points[index - 1];
            return !previous || point.x !== previous.x || point.y !== previous.y;
          });
          if (path.length >= 2) void act({ action: "drag", path });
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [
      act,
      controlling,
      frameSize.height,
      frameSize.width,
      remotePoint,
      status?.height,
      status?.width,
      trackpadMode,
    ]
  );

  const showModeToast = useCallback((message: string) => {
    setModeToast(message);
    setTimeout(() => setModeToast((current) => (current === message ? null : current)), 1_600);
  }, []);

  const pasteClipboard = async () => {
    if (!ready) return;
    if (!controlling) {
      changeTakeover(true);
      showModeToast("Taking control");
      return;
    }
    const text = await Clipboard.getStringAsync();
    if (!text) {
      showModeToast("Clipboard is empty");
      return;
    }
    await act({ action: "type", text });
    showModeToast("Pasted from iPhone");
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
          <BotMark color={bot?.color ?? "#8057F5"} icon={bot?.icon} size={26} />
          <Text numberOfLines={1} style={styles.title}>
            {bot?.name ?? "OpenBot"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <StageButton
            active={helpOpen}
            label="Using the computer"
            name="questionmark"
            onPress={() => setHelpOpen(true)}
          />
          <StageButton
            active={controlsOpen}
            label="Computer controls"
            name="ellipsis"
            onPress={() => setControlsOpen((current) => !current)}
            symbolSize={21}
          />
        </View>
      </View>

      {modeToast ? (
        <View pointerEvents="none" style={styles.modeToast}>
          <SymbolView
            name={trackpadMode ? "rectangle.and.hand.point.up.left" : "checkmark"}
            size={18}
            tintColor="#F7F7F4"
          />
          <Text style={styles.modeToastText}>{modeToast}</Text>
        </View>
      ) : null}

      <View style={styles.stage}>
        {!status && !error ? (
          <View accessibilityLabel="Connecting to computer" style={styles.connectingState}>
            <ActivityIndicator color="#92928D" />
            <Text style={styles.connectingCopy}>Connecting...</Text>
          </View>
        ) : (
          <View
            style={[styles.screenShell, { aspectRatio }]}
            onLayout={(event) => setFrameSize(event.nativeEvent.layout)}
          >
            {isFixture ? (
              <View
                {...panResponder.panHandlers}
                accessible
                accessibilityLabel={controlling ? "Tap the preview computer" : "Computer preview"}
                accessibilityRole="button"
                style={styles.frame}
              >
                <View style={[styles.frame, { transform: [{ scale: screenZoom }] }]}>
                  <FixtureDesktop />
                </View>
              </View>
            ) : frameUrl && ready ? (
              <View style={styles.frame}>
                <View
                  {...panResponder.panHandlers}
                  accessible
                  accessibilityLabel={controlling ? "Tap the shared computer" : "Shared computer"}
                  accessibilityRole="button"
                  style={styles.frame}
                >
                  <Image
                    onError={() => setFrameError("The latest computer frame could not be loaded")}
                    onLoad={() => setFrameError(null)}
                    resizeMode="contain"
                    source={{ uri: frameUrl, headers: authHeadersForUrl(frameUrl) }}
                    style={[styles.frame, { transform: [{ scale: screenZoom }] }]}
                  />
                </View>
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
              <View pointerEvents="none" style={styles.busyOverlay}>
                <ActivityIndicator color="#FFFFFF" />
              </View>
            ) : null}
          </View>
        )}
      </View>

      {controlsOpen ? (
        <View style={styles.controlTray}>
          <Pressable
            accessibilityLabel="Trackpad mode"
            accessibilityRole="switch"
            accessibilityState={{ checked: trackpadMode }}
            onPress={() => {
              const next = !trackpadMode;
              setTrackpadMode(next);
              setControlsOpen(false);
              showModeToast(next ? "Trackpad mode" : "Direct touch");
            }}
            style={({ pressed }) => [styles.modeRow, pressed && styles.stageButtonPressed]}
          >
            <SymbolView name="rectangle.and.hand.point.up.left" size={20} tintColor="#F7F7F4" />
            <Text style={styles.modeRowLabel}>Trackpad Mode</Text>
            <View style={[styles.modeSwitch, trackpadMode && styles.modeSwitchOn]}>
              <View style={[styles.modeSwitchKnob, trackpadMode && styles.modeSwitchKnobOn]} />
            </View>
          </Pressable>
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
          {screenZoom > 1.01 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                zoomRef.current = 1;
                setScreenZoom(1);
                setControlsOpen(false);
                showModeToast("Zoom reset");
              }}
              style={({ pressed }) => [styles.resetZoom, pressed && styles.stageButtonPressed]}
            >
              <SymbolView name="arrow.down.right.and.arrow.up.left" size={15} tintColor="#B9B9B5" />
              <Text style={styles.resetZoomLabel}>Reset zoom</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
        style={styles.keyboardLayer}
      >
        <View style={styles.bottomToolbar}>
          <StageButton
            disabled={!ready || takeoverBusy}
            label="Paste from iPhone clipboard"
            name="clipboard"
            onPress={() => void pasteClipboard()}
            size={34}
            symbolSize={17}
          />
          {keyboardOpen ? (
            <TextInput
              accessibilityLabel="Type on shared computer"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={ready}
              keyboardAppearance="dark"
              onChangeText={handleKeyboardChange}
              onSubmitEditing={submitKeyboard}
              ref={inputRef}
              returnKeyType="send"
              showSoftInputOnFocus
              spellCheck={false}
              style={styles.hiddenInput}
              value={typing}
            />
          ) : null}
          <StageButton
            active={keyboardOpen}
            disabled={!ready}
            label={keyboardOpen ? "Close keyboard" : "Type on computer"}
            name="keyboard"
            onPress={() => (keyboardOpen ? closeKeyboard() : openKeyboard())}
            size={34}
            symbolSize={17}
          />
        </View>
      </KeyboardAvoidingView>

      <ComputerHelpSheet onClose={() => setHelpOpen(false)} visible={helpOpen} />
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
    maxWidth: 176,
    height: 40,
    paddingHorizontal: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    overflow: "hidden",
  },
  title: {
    flexShrink: 1,
    color: "#F7F7F4",
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "600",
  },
  headerActions: { marginLeft: "auto", flexDirection: "row", gap: 8 },
  modeToast: {
    position: "absolute",
    zIndex: 12,
    top: 48,
    right: 12,
    minWidth: 210,
    height: 58,
    borderRadius: 29,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
    backgroundColor: "rgba(43,43,43,0.96)",
    paddingHorizontal: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    shadowColor: "#000",
    shadowOpacity: 0.34,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  modeToastText: { color: "#F7F7F4", fontSize: 17, lineHeight: 22, fontWeight: "500" },
  stage: { flex: 1, alignItems: "center", justifyContent: "flex-start", paddingTop: 28 },
  connectingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingBottom: 44,
  },
  connectingCopy: { color: "#F7F7F4", fontSize: 15, lineHeight: 20 },
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
    bottom: 82,
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
  modeRow: {
    minHeight: 52,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  modeRowLabel: { flex: 1, color: "#F7F7F4", fontSize: 15, lineHeight: 20, fontWeight: "600" },
  modeSwitch: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 2,
    backgroundColor: "#4A4A48",
  },
  modeSwitchOn: { backgroundColor: "#30D158" },
  modeSwitchKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#FFFFFF",
  },
  modeSwitchKnobOn: { alignSelf: "flex-end" },
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
  resetZoom: {
    minHeight: 40,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 10,
    paddingTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resetZoomLabel: { color: "#B9B9B5", fontSize: 13, lineHeight: 17 },
  keyboardLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "flex-end",
  },
  bottomToolbar: {
    minHeight: 64,
    paddingHorizontal: 11,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  hiddenInput: {
    position: "absolute",
    left: "50%",
    bottom: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    color: "transparent",
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
