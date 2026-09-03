import type { ScreenActionInput, ScreenStatusView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
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
import {
  clampComputerViewport,
  computerPointFromScreen,
  computerTouchCentroid,
  computerTouchDistance,
  moveComputerTrackpadPointer,
  screenPointFromComputer,
  updateComputerViewport,
} from "../../src/computer-viewport";
import { useOpenTeam } from "../../src/state/openteam-context";

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
            <Text style={styles.fixtureAddressText}>openteam.local</Text>
          </View>
        </View>
        <View style={styles.fixtureContent}>
          <Text style={styles.fixtureHeading}>Sign in to OpenTeam</Text>
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
  const { botId, handoffId } = useLocalSearchParams<{ botId: string; handoffId?: string }>();
  const {
    isFixture,
    mutateComputerHandoff,
    screenAction,
    screenFrameUrl,
    screenStatus,
    setScreenTakeover,
    snapshot,
  } = useOpenTeam();
  const bot = snapshot.bots.find((candidate) => candidate.id === botId);
  const [status, setStatus] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [typing, setTyping] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [trackpadMode, setTrackpadMode] = useState(false);
  const [screenZoom, setScreenZoom] = useState(1);
  const [screenOffset, setScreenOffset] = useState({ x: 0, y: 0 });
  const [trackpadPointer, setTrackpadPointer] = useState({ x: 640, y: 400 });
  const [modeToast, setModeToast] = useState<string | null>(null);
  const refreshEpoch = useRef(0);
  const statusRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const actionTail = useRef<Promise<void>>(Promise.resolve());
  const pendingActions = useRef(0);
  const keyboardValue = useRef("");
  const keyboardBuffer = useRef("");
  const keyboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef({ x: 640, y: 400 });
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const lastTapAt = useRef(0);
  const handoffFinished = useRef(false);
  const handoffDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef({
    startedAt: 0,
    touches: 1,
    startDistance: 0,
    startZoom: 1,
    startCentroid: { x: 0, y: 0 },
    multiTouchDelta: { x: 0, y: 0 },
    startOffset: { x: 0, y: 0 },
    startPoint: { x: 640, y: 400 },
    pointerStart: { x: 640, y: 400 },
    path: [] as Array<{ x: number; y: number }>,
    multiTouch: false,
    pinching: false,
    viewportGesture: false,
    trackpadDrag: false,
  });
  const busy = actionBusy;

  const applyViewport = useCallback(
    (viewport: { zoom: number; offset: { x: number; y: number } }) => {
      const bounded = clampComputerViewport(viewport, frameSize);
      zoomRef.current = bounded.zoom;
      offsetRef.current = bounded.offset;
      setScreenZoom(bounded.zoom);
      setScreenOffset(bounded.offset);
    },
    [frameSize]
  );

  const resetViewport = useCallback(() => {
    zoomRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
    setScreenZoom(1);
    setScreenOffset({ x: 0, y: 0 });
  }, []);

  const refresh = useCallback(async () => {
    if (!botId || refreshInFlight.current || AppState.currentState !== "active") return;
    const epoch = refreshEpoch.current;
    const revision = statusRevision.current;
    refreshInFlight.current = true;
    try {
      const next = await screenStatus(botId);
      if (epoch !== refreshEpoch.current || revision !== statusRevision.current) return;
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
      void refresh();
      const timer = setInterval(() => void refresh(), 2_500);
      const appStateSubscription = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          void refresh();
          return;
        }
        refreshEpoch.current += 1;
        statusRevision.current += 1;
      });
      return () => {
        appStateSubscription.remove();
        clearInterval(timer);
        refreshEpoch.current += 1;
        statusRevision.current += 1;
      };
    }, [refresh])
  );

  useFocusEffect(
    useCallback(() => {
      if (handoffDismissTimer.current) {
        clearTimeout(handoffDismissTimer.current);
        handoffDismissTimer.current = null;
      }
      handoffFinished.current = false;
      return () => {
        if (!handoffId || handoffFinished.current) return;
        handoffDismissTimer.current = setTimeout(() => {
          handoffDismissTimer.current = null;
          if (handoffFinished.current) return;
          handoffFinished.current = true;
          void mutateComputerHandoff(handoffId, "dismiss").catch(() => undefined);
        }, 0);
      };
    }, [handoffId, mutateComputerHandoff])
  );

  useEffect(() => {
    if (!botId || !handoffId) return;
    const heartbeat = () => {
      if (AppState.currentState !== "active") return;
      void setScreenTakeover(botId, true)
        .then(setStatus)
        .catch(() => undefined);
    };
    heartbeat();
    const timer = setInterval(heartbeat, 20_000);
    return () => clearInterval(timer);
  }, [botId, handoffId, setScreenTakeover]);

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
    const bounded = clampComputerViewport(
      { zoom: zoomRef.current, offset: offsetRef.current },
      frameSize
    );
    if (
      bounded.zoom !== zoomRef.current ||
      bounded.offset.x !== offsetRef.current.x ||
      bounded.offset.y !== offsetRef.current.y
    ) {
      applyViewport(bounded);
    }
  }, [applyViewport, frameSize]);

  const performAction = useCallback(
    async (input: ScreenActionInput) => {
      if (!botId) return;
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

  const openKeyboard = () => {
    setControlsOpen(false);
    setKeyboardOpen(true);
  };

  const frameUrl = botId ? screenFrameUrl(botId, frameRevision) : null;
  const ready = status?.state === "ready";
  const aspectRatio =
    status && status.width > 0 && status.height > 0 ? status.width / status.height : 1.6;

  const flushKeyboardBuffer = useCallback(() => {
    if (keyboardTimer.current) {
      clearTimeout(keyboardTimer.current);
      keyboardTimer.current = null;
    }
    const text = keyboardBuffer.current;
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

  const closeKeyboard = useCallback(() => {
    flushKeyboardBuffer();
    keyboardValue.current = "";
    setTyping("");
    setKeyboardOpen(false);
    Keyboard.dismiss();
  }, [flushKeyboardBuffer]);

  const remotePoint = useCallback(
    (localX: number, localY: number) => {
      return computerPointFromScreen(
        { x: localX, y: localY },
        frameSize,
        { width: status?.width ?? 1280, height: status?.height ?? 800 },
        { zoom: zoomRef.current, offset: offsetRef.current }
      );
    },
    [frameSize, status?.height, status?.width]
  );

  const trackpadPointerOnScreen = screenPointFromComputer(
    trackpadPointer,
    frameSize,
    { width: status?.width ?? 1280, height: status?.height ?? 800 },
    { zoom: screenZoom, offset: screenOffset }
  );

  const panResponder = useMemo(() => {
    const beginMultiTouch = (touches: Parameters<typeof computerTouchDistance>[0]) => {
      const centroid = computerTouchCentroid(touches);
      gesture.current.touches = Math.max(2, gesture.current.touches);
      gesture.current.multiTouch = true;
      gesture.current.startDistance = computerTouchDistance(touches);
      gesture.current.startZoom = zoomRef.current;
      gesture.current.startCentroid = centroid;
      gesture.current.multiTouchDelta = { x: 0, y: 0 };
      gesture.current.startOffset = { ...offsetRef.current };
      gesture.current.startPoint = remotePoint(centroid.x, centroid.y);
      gesture.current.viewportGesture = false;
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => ready,
      onMoveShouldSetPanResponder: () => ready,
      onPanResponderGrant: (event) => {
        const touches = event.nativeEvent.touches;
        const multiTouch = touches.length >= 2;
        const centroid = multiTouch
          ? computerTouchCentroid(touches)
          : { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
        const startPoint = remotePoint(centroid.x, centroid.y);
        const startedAt = Date.now();
        gesture.current = {
          startedAt,
          touches: Math.max(1, touches.length),
          startDistance: multiTouch ? computerTouchDistance(touches) : 0,
          startZoom: zoomRef.current,
          startCentroid: centroid,
          multiTouchDelta: { x: 0, y: 0 },
          startOffset: { ...offsetRef.current },
          startPoint,
          pointerStart: { ...pointer.current },
          path: [startPoint],
          multiTouch,
          pinching: false,
          viewportGesture: false,
          trackpadDrag: trackpadMode && startedAt - lastTapAt.current < 320,
        };
      },
      onPanResponderStart: (event) => {
        const touches = event.nativeEvent.touches;
        if (touches.length >= 2 && !gesture.current.multiTouch) beginMultiTouch(touches);
      },
      onPanResponderMove: (event, state) => {
        const touches = event.nativeEvent.touches;
        gesture.current.touches = Math.max(gesture.current.touches, touches.length);
        if (touches.length >= 2) {
          if (!gesture.current.multiTouch) beginMultiTouch(touches);
          const centroid = computerTouchCentroid(touches);
          gesture.current.multiTouchDelta = {
            x: centroid.x - gesture.current.startCentroid.x,
            y: centroid.y - gesture.current.startCentroid.y,
          };
          const distance = computerTouchDistance(touches);
          const ratio =
            gesture.current.startDistance > 0 ? distance / gesture.current.startDistance : 1;
          if (Math.abs(ratio - 1) > 0.035 || gesture.current.pinching) {
            gesture.current.pinching = true;
          }
          const movedViewport =
            Math.hypot(gesture.current.multiTouchDelta.x, gesture.current.multiTouchDelta.y) > 3;
          if ((gesture.current.startZoom > 1.01 && movedViewport) || gesture.current.pinching) {
            gesture.current.viewportGesture = true;
            applyViewport(
              updateComputerViewport(
                {
                  zoom: gesture.current.startZoom,
                  offset: gesture.current.startOffset,
                  centroid: gesture.current.startCentroid,
                  distance: gesture.current.startDistance,
                },
                touches,
                frameSize,
                gesture.current.pinching
              )
            );
          }
          return;
        }
        if (gesture.current.multiTouch) return;
        if (trackpadMode) {
          const nextPointer = moveComputerTrackpadPointer(
            gesture.current.pointerStart,
            { x: state.dx, y: state.dy },
            frameSize,
            { width: status?.width ?? 1280, height: status?.height ?? 800 },
            zoomRef.current
          );
          pointer.current = nextPointer;
          setTrackpadPointer(nextPointer);
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
      onPanResponderRelease: (event, state) => {
        if (gesture.current.viewportGesture) return;
        const distance = Math.hypot(state.dx, state.dy);
        const held = Date.now() - gesture.current.startedAt;
        if (gesture.current.touches >= 2) {
          const multiDistance = Math.hypot(
            gesture.current.multiTouchDelta.x,
            gesture.current.multiTouchDelta.y
          );
          if (multiDistance < 10) {
            const point = trackpadMode ? pointer.current : gesture.current.startPoint;
            void act({ action: "click", ...point, button: "right" });
          } else {
            const deltaY = Math.max(
              -20,
              Math.min(20, Math.round(gesture.current.multiTouchDelta.y / 18))
            );
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
            : remotePoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
        const path = [...gesture.current.path, end].filter((point, index, points) => {
          const previous = points[index - 1];
          return !previous || point.x !== previous.x || point.y !== previous.y;
        });
        if (path.length >= 2) void act({ action: "drag", path });
      },
      onPanResponderTerminationRequest: () => false,
    });
  }, [
    act,
    applyViewport,
    frameSize,
    ready,
    remotePoint,
    status?.height,
    status?.width,
    trackpadMode,
  ]);

  const showModeToast = useCallback((message: string) => {
    setModeToast(message);
    setTimeout(() => setModeToast((current) => (current === message ? null : current)), 1_600);
  }, []);

  const pasteClipboard = async () => {
    if (!ready) return;
    const text = await Clipboard.getStringAsync();
    if (!text) {
      showModeToast("Clipboard is empty");
      return;
    }
    await act({ action: "type", text });
    showModeToast("Pasted from iPhone");
  };

  const finishHandoff = async (action: "complete" | "skip" | "dismiss") => {
    if (!handoffId || handoffFinished.current) return;
    handoffFinished.current = true;
    try {
      await mutateComputerHandoff(handoffId, action);
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (cause) {
      handoffFinished.current = false;
      setError(clientErrorMessage(cause, "Could not return computer control"));
    }
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <StageButton
          label="Back to conversation"
          name="chevron.left"
          onPress={() => {
            if (handoffId) {
              void finishHandoff("dismiss");
              return;
            }
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
          symbolSize={20}
        />
        <View style={styles.titlePill}>
          <BotMark color={bot?.color ?? "#8057F5"} icon={bot?.icon} size={26} />
          <Text numberOfLines={1} style={styles.title}>
            {bot?.name ?? "OpenTeam"}
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

      {handoffId ? (
        <View style={styles.handoffBar}>
          <Text numberOfLines={1} style={styles.handoffLabel}>
            Complete the requested step
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void finishHandoff("skip")}
            style={({ pressed }) => [styles.handoffSecondary, pressed && styles.stageButtonPressed]}
          >
            <Text style={styles.handoffSecondaryLabel}>Skip this step</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void finishHandoff("complete")}
            style={({ pressed }) => [styles.handoffPrimary, pressed && styles.stageButtonPressed]}
          >
            <Text style={styles.handoffPrimaryLabel}>I'm done, continue</Text>
          </Pressable>
        </View>
      ) : null}

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
                accessibilityLabel="Interactive preview computer"
                accessibilityRole="button"
                style={styles.frame}
              >
                <View
                  pointerEvents="none"
                  style={[
                    styles.frame,
                    { transform: [{ translateX: screenOffset.x }, { translateY: screenOffset.y }] },
                  ]}
                >
                  <View style={[styles.frame, { transform: [{ scale: screenZoom }] }]}>
                    <FixtureDesktop />
                  </View>
                </View>
                {trackpadMode ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.trackpadPointer,
                      { left: trackpadPointerOnScreen.x, top: trackpadPointerOnScreen.y },
                    ]}
                  >
                    <SymbolView
                      name="cursorarrow"
                      size={22}
                      tintColor="#FFFFFF"
                      weight="semibold"
                    />
                  </View>
                ) : null}
              </View>
            ) : frameUrl && ready ? (
              <View style={styles.frame}>
                <View
                  {...panResponder.panHandlers}
                  accessible
                  accessibilityLabel="Interactive shared computer"
                  accessibilityRole="button"
                  style={styles.frame}
                >
                  <View
                    pointerEvents="none"
                    style={[
                      styles.frame,
                      {
                        transform: [{ translateX: screenOffset.x }, { translateY: screenOffset.y }],
                      },
                    ]}
                  >
                    <Image
                      onError={() => setFrameError("The latest computer frame could not be loaded")}
                      onLoad={() => setFrameError(null)}
                      resizeMode="contain"
                      source={{ uri: frameUrl, headers: authHeadersForUrl(frameUrl) }}
                      style={[styles.frame, { transform: [{ scale: screenZoom }] }]}
                    />
                  </View>
                  {trackpadMode ? (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.trackpadPointer,
                        { left: trackpadPointerOnScreen.x, top: trackpadPointerOnScreen.y },
                      ]}
                    >
                      <SymbolView
                        name="cursorarrow"
                        size={22}
                        tintColor="#FFFFFF"
                        weight="semibold"
                      />
                    </View>
                  ) : null}
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
        {ready && screenZoom > 1.01 ? (
          <Pressable
            accessibilityLabel="Reset zoom"
            accessibilityRole="button"
            onPress={() => {
              resetViewport();
              showModeToast("Zoom reset");
            }}
            style={({ pressed }) => [styles.viewportReset, pressed && styles.stageButtonPressed]}
          >
            <SymbolView name="arrow.down.right.and.arrow.up.left" size={14} tintColor="#F7F7F4" />
            <Text style={styles.viewportResetLabel}>Reset zoom</Text>
          </Pressable>
        ) : null}
      </View>

      {controlsOpen ? (
        <View style={styles.controlTray}>
          <Pressable
            accessibilityLabel="Trackpad mode"
            accessibilityRole="switch"
            accessibilityState={{ checked: trackpadMode }}
            onPress={() => {
              const next = !trackpadMode;
              lastTapAt.current = 0;
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
                {error ?? frameError ?? (ready ? "Connected" : "Connecting…")}
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
                disabled={!ready || busy}
                key={app}
                onPress={() => void act({ action: "open_app", app })}
              />
            ))}
          </View>
          <View style={styles.controlRow}>
            <View style={styles.scrollControls}>
              <StageButton
                disabled={!ready || busy}
                label="Scroll up"
                name="chevron.up"
                onPress={() => void act({ action: "scroll", deltaY: -6 })}
                size={38}
                symbolSize={14}
              />
              <StageButton
                disabled={!ready || busy}
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
                resetViewport();
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
            disabled={!ready || busy}
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
              onBlur={closeKeyboard}
              onChangeText={handleKeyboardChange}
              onSubmitEditing={submitKeyboard}
              ref={inputRef}
              returnKeyType="default"
              showSoftInputOnFocus
              spellCheck={false}
              style={styles.hiddenInput}
              submitBehavior="submit"
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
    height: 42,
    paddingHorizontal: 14,
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
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.09)",
    backgroundColor: "#292929",
    paddingLeft: 6,
    paddingRight: 12,
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
  handoffBar: {
    minHeight: 46,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.09)",
  },
  handoffLabel: { flex: 1, color: "#B9B9B5", fontSize: 13, lineHeight: 18 },
  handoffSecondary: { paddingHorizontal: 8, paddingVertical: 7 },
  handoffSecondaryLabel: { color: "#B9B9B5", fontSize: 13, fontWeight: "600" },
  handoffPrimary: {
    borderRadius: 8,
    backgroundColor: "#F7F7F4",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  handoffPrimaryLabel: { color: "#111111", fontSize: 13, fontWeight: "600" },
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
  stage: { flex: 1, alignItems: "center", justifyContent: "flex-start", paddingTop: 64 },
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
  trackpadPointer: {
    position: "absolute",
    zIndex: 3,
    width: 24,
    height: 24,
    marginLeft: -2,
    marginTop: -2,
    shadowColor: "#000000",
    shadowOpacity: 0.9,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  viewportReset: {
    position: "absolute",
    zIndex: 5,
    top: 72,
    right: 10,
    minHeight: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(34,34,34,0.92)",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  viewportResetLabel: { color: "#F7F7F4", fontSize: 12, lineHeight: 16, fontWeight: "600" },
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
    justifyContent: "flex-end",
  },
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
