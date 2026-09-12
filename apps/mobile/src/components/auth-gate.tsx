import type { OpenTeamAuthStatus } from "@openteam/client-core/auth";
import { authErrorMessage } from "@openteam/product-core/auth-feedback";
import * as Haptics from "../haptics";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Platform,
  Pressable,
  type PressableProps,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  authenticateConnection,
  getConfiguredAuthServer,
  hasValidSession,
  onAuthenticationRequired,
  testServerConnection,
} from "../auth";
import {
  loadServerConnection,
  normalizeServerConnection,
  saveServerConnection,
} from "../server-config";
import { useTheme } from "../theme";
import { BotMark } from "./bot-mark";
import { GlassGroup, GlassSurface } from "./glass-surface";

type SignInStage = "welcome" | "endpoint" | "credentials";

// A round trip that resolves instantly reads as a dead button, so the spinner is held long enough
// to register as work before the result haptic lands.
const MINIMUM_SUBMIT_MS = 350;

async function holdSpinner(startedAt: number) {
  const remaining = MINIMUM_SUBMIT_MS - (Date.now() - startedAt);
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

// Animate notice content, never a glass surface's ancestor opacity. Keep the text during
// dismissal and measure it unconstrained, so multiline errors also expand and collapse smoothly.
function AuthNotice({
  message,
  color,
  reduceMotion,
}: {
  message: string | null;
  color: string;
  reduceMotion: boolean;
}) {
  const lastMessage = useRef(message);
  if (message) lastMessage.current = message;
  const [contentHeight, setContentHeight] = useState(0);
  const noticeHeight = useRef(new Animated.Value(0)).current;
  const visibility = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.parallel([
      Animated.timing(noticeHeight, {
        toValue: message ? contentHeight : 0,
        duration: reduceMotion ? 0 : 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(visibility, {
        toValue: message ? 1 : 0,
        duration: reduceMotion ? 0 : 180,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [contentHeight, message, noticeHeight, reduceMotion, visibility]);
  useEffect(() => {
    if (message && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
    }
  }, [message]);
  return (
    <Animated.View
      accessibilityElementsHidden={!message}
      importantForAccessibility={message ? "auto" : "no-hide-descendants"}
      style={{ height: noticeHeight, overflow: "hidden" }}
    >
      <Animated.View
        onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          paddingTop: 8,
          paddingBottom: 2,
          opacity: visibility,
          transform: [
            { translateY: visibility.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) },
          ],
        }}
      >
        <Text accessibilityLiveRegion="polite" style={[styles.error, { color }]}>
          {lastMessage.current}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

function AuthSubmitLabel({
  busy,
  busyLabel,
  idleLabel,
  color,
  reduceMotion,
}: {
  busy: boolean;
  busyLabel: string;
  idleLabel: string;
  color: string;
  reduceMotion: boolean;
}) {
  const progress = useRef(new Animated.Value(busy ? 1 : 0)).current;
  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: busy ? 1 : 0,
      duration: reduceMotion ? 0 : 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [busy, progress, reduceMotion]);
  return (
    <View
      style={{ flex: 1, minHeight: 24 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.submitLabel,
          { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
        ]}
      >
        <Text style={[styles.primaryButtonText, { color }]}>{idleLabel}</Text>
      </Animated.View>
      <Animated.View style={[styles.submitLabel, { opacity: progress }]}>
        <ActivityIndicator animating={busy} color={color} size="small" />
        <Text style={[styles.primaryButtonText, { color }]}>{busyLabel}</Text>
      </Animated.View>
    </View>
  );
}

function AuthButton({
  reduceMotion,
  style,
  disabled,
  ...props
}: PressableProps & { reduceMotion: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const animatePress = (pressed: boolean) => {
    Animated.spring(scale, {
      toValue: pressed && !reduceMotion ? 0.975 : 1,
      stiffness: 450,
      damping: 30,
      mass: 0.6,
      useNativeDriver: true,
    }).start();
  };
  useEffect(() => {
    if (disabled || reduceMotion) {
      scale.stopAnimation();
      scale.setValue(1);
    }
    return () => scale.stopAnimation();
  }, [disabled, reduceMotion, scale]);
  return (
    <Pressable
      {...props}
      disabled={disabled}
      style={style}
      onPressIn={() => animatePress(true)}
      onPressOut={() => animatePress(false)}
    >
      {(state) => (
        <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
          {typeof props.children === "function" ? props.children(state) : props.children}
        </Animated.View>
      )}
    </Pressable>
  );
}

const decorations = [
  { color: "#08c875", icon: "chip", left: 0.18, size: 0.205, top: 0.11, rotate: "-8deg" },
  { color: "#f72591", icon: "pod", left: 0.57, size: 0.16, top: 0.17, rotate: "18deg" },
  { color: "#8850f5", icon: "terminal", left: -0.02, size: 0.14, top: 0.31, rotate: "80deg" },
  { color: "#9d683e", icon: "helmet", left: 0.88, size: 0.16, top: 0.31, rotate: "-22deg" },
  { color: "#ff9912", icon: "helmet", left: -0.09, size: 0.2, top: 0.5, rotate: "15deg" },
  { color: "#ff2445", icon: "helmet", left: 0.93, size: 0.2, top: 0.51, rotate: "-22deg" },
  { color: "#1685ed", icon: "tv-head", left: 0.03, size: 0.18, top: 0.7, rotate: "4deg" },
  { color: "#08bca9", icon: "helmet", left: 0.8, size: 0.16, top: 0.7, rotate: "-18deg" },
  { color: "#ff6811", icon: "hex-visor", left: 0.36, size: 0.21, top: 0.76, rotate: "4deg" },
] as const;

function IdleBot({
  color,
  icon,
  index,
  reduceMotion,
  size,
}: {
  color: string;
  icon: string;
  index: number;
  reduceMotion: boolean;
  size: number;
}) {
  const idleProgress = useRef(new Animated.Value(0)).current;
  const direction = index % 2 === 0 ? 1 : -1;
  const verticalTravel = 4 + (index % 3) * 1.25;
  const duration = 1750 + (index % 4) * 180;

  useEffect(() => {
    idleProgress.stopAnimation();
    idleProgress.setValue(0);
    if (reduceMotion) return;

    const animation = Animated.sequence([
      Animated.delay(index * 95),
      Animated.loop(
        Animated.sequence([
          Animated.timing(idleProgress, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.sin),
            isInteraction: false,
            useNativeDriver: true,
          }),
          Animated.timing(idleProgress, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.sin),
            isInteraction: false,
            useNativeDriver: true,
          }),
        ])
      ),
    ]);
    animation.start();
    return () => animation.stop();
  }, [duration, idleProgress, index, reduceMotion]);

  const translateX = idleProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, direction * 2.5],
  });
  const translateY = idleProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -verticalTravel],
  });
  const rotate = idleProgress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", `${direction * 2.2}deg`],
  });
  const scale = idleProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.018],
  });

  return (
    <Animated.View style={{ transform: [{ translateX }, { translateY }, { rotate }, { scale }] }}>
      <BotMark color={color} faceColor="#111111" icon={icon} size={size} />
    </Animated.View>
  );
}

function BotField({
  reduceMotion,
  transitionProgress,
}: {
  reduceMotion: boolean;
  transitionProgress: Animated.Value;
}) {
  const { width, height } = useWindowDimensions();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.botField}
    >
      {decorations.map((decoration, index) => {
        const size = width * decoration.size;
        // The bottom row sits behind the sign-in card. It stays on screen so the glass has
        // something to refract instead of a flat backdrop.
        const settlesBehindPanel = index >= 6;
        return (
          <Animated.View
            key={`${decoration.icon}-${decoration.color}`}
            style={[
              {
                left: width * decoration.left,
                position: "absolute",
                top: height * decoration.top,
                transform: [{ rotate: decoration.rotate }],
              },
              settlesBehindPanel && {
                opacity: transitionProgress.interpolate({
                  inputRange: [0, 1, 2],
                  outputRange: [1, 0.92, 0.72],
                  extrapolate: "clamp",
                }),
                transform: [
                  { rotate: decoration.rotate },
                  {
                    scale: transitionProgress.interpolate({
                      inputRange: [0, 1, 2],
                      outputRange: [1, 0.94, 0.86],
                      extrapolate: "clamp",
                    }),
                  },
                ],
              },
            ]}
          >
            <IdleBot
              color={decoration.color}
              icon={decoration.icon}
              index={index}
              reduceMotion={reduceMotion}
              size={size}
            />
          </Animated.View>
        );
      })}
    </View>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<OpenTeamAuthStatus>("checking");
  const [stage, setStage] = useState<SignInStage>("welcome");
  const [reduceMotion, setReduceMotion] = useState(true);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [keyboardDuration, setKeyboardDuration] = useState(250);
  const authRequestGeneration = useRef(0);
  const usernameInput = useRef<TextInput>(null);
  const passwordInput = useRef<TextInput>(null);
  const requestPending = useRef(false);
  const stageProgress = useRef(new Animated.Value(0)).current;
  const keyboardProgress = useRef(new Animated.Value(0)).current;
  const panelLift = useRef(new Animated.Value(0)).current;
  const appEntryOffset = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    if (state !== "authenticated") {
      appEntryOffset.setValue(12);
      return;
    }
    // Slide the app into place at full opacity so native glass keeps its backdrop.
    const animation = Animated.timing(appEntryOffset, {
      toValue: 0,
      duration: reduceMotion ? 0 : 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [appEntryOffset, reduceMotion, state]);
  const loginBackground = theme.dark ? "#101010" : "#f5f5f3";
  const actionBackground = theme.dark ? "#ffffff" : "#111111";
  const actionForeground = theme.dark ? "#111111" : "#ffffff";
  const actionGlassBorder = theme.dark ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.24)";
  // A disabled pill is dimmed through its own glass tint, never through ancestor opacity.
  const disabledGlassTint = theme.dark ? "rgba(255,255,255,0.30)" : "rgba(17,17,17,0.32)";
  const cardFallback = theme.dark ? "rgba(35,35,35,0.92)" : "rgba(255,255,255,0.84)";
  const fieldBackground = theme.dark ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.56)";
  const primaryGlassTint = theme.dark ? "rgba(255,255,255,0.82)" : "rgba(17,17,17,0.78)";
  const secondaryGlassTint = theme.dark ? "rgba(58,58,58,0.58)" : "rgba(255,255,255,0.42)";
  // Text on a glass card composites over whatever the backdrop refracts, so the opaque-surface
  // tokens are far too light here: textFaint measures about 1.7:1 against the frosted panel. These
  // are alpha-based so they keep their contrast as the backdrop shifts.
  const glassLabel = theme.dark ? "rgba(255,255,255,0.78)" : "rgba(17,17,17,0.72)";
  const glassSecondary = theme.dark ? "rgba(255,255,255,0.70)" : "rgba(17,17,17,0.62)";
  const glassPlaceholder = theme.dark ? "rgba(255,255,255,0.46)" : "rgba(17,17,17,0.42)";
  const glassDanger = theme.dark ? "#FF8A8F" : "#B32328";
  const mutedActionForeground = theme.dark ? "rgba(255,255,255,0.72)" : "rgba(17,17,17,0.66)";
  const mutedCancelForeground = theme.dark ? "rgba(247,247,244,0.5)" : "rgba(0,0,0,0.42)";
  const hasUsername = username.trim().length > 0;
  const hasPassword = password.length > 0;
  const hasCompleteCredentials = hasUsername && hasPassword;
  const usesCleartextHttp = /^http:\/\//i.test(serverUrl.trim());
  const connectDisabled = submitting || !serverUrl.trim();
  const signInDisabled = submitting || !hasCompleteCredentials;
  const stageTarget = stage === "welcome" ? 0 : stage === "endpoint" ? 1 : 2;
  const welcomeHeroOffset = Math.max(0, height * 0.42 - 48);
  const formMaxHeight = Math.max(120, height - insets.top - insets.bottom - keyboardInset - 100);
  // Every stage transition slides rather than cross-fades. UIKit drops a glass view's backdrop as
  // soon as an ancestor's alpha leaves 1 and never restores it, so a faded-in card would arrive
  // permanently flat. Off-stage surfaces are parked outside the clipped root instead.
  const offstageX = width + 24;
  const heroTranslateY = Animated.add(
    stageProgress.interpolate({
      inputRange: [0, 1, 2],
      outputRange: [welcomeHeroOffset, 0, 0],
    }),
    keyboardProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [0, -(height * 0.42)],
    })
  );
  const heroScale = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [1, 0.96, 0.96],
  });
  const welcomeTranslateY = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [0, 132, 132],
  });
  const endpointTranslateX = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [offstageX, 0, -offstageX],
  });
  const credentialsTranslateX = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [offstageX, offstageX, 0],
  });
  const updateServerUrl = (value: string) => {
    if (value !== serverUrl) {
      setUsername("");
      setPassword("");
    }
    setServerUrl(value);
    setError(null);
  };
  const updateUsername = (value: string) => {
    setUsername(value);
    setError(null);
  };
  const updatePassword = (value: string) => {
    setPassword(value);
    setError(null);
  };

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const animation = Animated.timing(stageProgress, {
      toValue: stageTarget,
      duration: reduceMotion ? 0 : stage === "welcome" ? 320 : stage === "endpoint" ? 420 : 340,
      easing: stage === "welcome" ? Easing.inOut(Easing.cubic) : Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      if (stage === "credentials") usernameInput.current?.focus();
    });
    return () => animation.stop();
  }, [reduceMotion, stage, stageProgress, stageTarget]);

  useEffect(() => {
    const animation = Animated.timing(keyboardProgress, {
      toValue: stage !== "welcome" && keyboardVisible ? 1 : 0,
      duration: reduceMotion ? 0 : keyboardDuration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [keyboardDuration, keyboardProgress, keyboardVisible, reduceMotion, stage]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAuthenticationRequired(() => {
      const generation = authRequestGeneration.current + 1;
      authRequestGeneration.current = generation;
      requestPending.current = false;
      setSubmitting(false);
      setPassword("");
      setError(null);
      const configured = getConfiguredAuthServer();
      if (!configured) {
        setStage("endpoint");
        setState("signed-out");
        return;
      }
      setServerUrl(configured);
      setState("checking");
      void hasValidSession(configured)
        .then((valid) => {
          if (cancelled || generation !== authRequestGeneration.current) return;
          setStage(valid ? "welcome" : "credentials");
          setState(valid ? "authenticated" : "signed-out");
        })
        .catch(() => {
          if (cancelled || generation !== authRequestGeneration.current) return;
          setStage("credentials");
          setState("signed-out");
        });
    });
    const initialGeneration = authRequestGeneration.current + 1;
    authRequestGeneration.current = initialGeneration;
    void loadServerConnection()
      .then(async (connection) => {
        if (cancelled || initialGeneration !== authRequestGeneration.current) return;
        setServerUrl(connection.serverUrl);
        if (!connection.serverUrl) {
          setState("signed-out");
          return;
        }
        const valid = await hasValidSession(connection.serverUrl);
        if (!cancelled && initialGeneration === authRequestGeneration.current) {
          setState(valid ? "authenticated" : "signed-out");
        }
      })
      .catch((cause) => {
        if (cancelled || initialGeneration !== authRequestGeneration.current) return;
        setError(authErrorMessage(cause, "Could not load the OpenTeam server"));
        setState("signed-out");
      });
    return () => {
      cancelled = true;
      authRequestGeneration.current += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (event) => {
      setKeyboardVisible(true);
      setKeyboardDuration(event.duration || 250);
      setKeyboardInset(Math.max(0, height - event.endCoordinates.screenY - insets.bottom));
    });
    const hide = Keyboard.addListener(hideEvent, (event) => {
      setKeyboardDuration(event.duration || 250);
      setKeyboardVisible(false);
      setKeyboardInset(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [height, insets.bottom]);

  useEffect(() => {
    const animation = Animated.timing(panelLift, {
      toValue: -keyboardInset,
      duration: reduceMotion ? 0 : keyboardDuration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [keyboardDuration, keyboardInset, panelLift, reduceMotion]);

  const connectToServer = async () => {
    if (connectDisabled || requestPending.current) return;
    let normalized: ReturnType<typeof normalizeServerConnection>;
    try {
      normalized = normalizeServerConnection({ serverUrl });
    } catch (cause) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(authErrorMessage(cause, "Enter your server address."));
      return;
    }
    requestPending.current = true;
    const generation = authRequestGeneration.current + 1;
    authRequestGeneration.current = generation;
    const startedAt = Date.now();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSubmitting(true);
    setError(null);
    try {
      const result = await testServerConnection(normalized.serverUrl);
      await holdSpinner(startedAt);
      if (generation !== authRequestGeneration.current) return;
      setServerUrl(normalized.serverUrl);
      if (result === "credentials-required") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setStage("credentials");
        return;
      }
      await saveServerConnection(normalized);
      if (generation !== authRequestGeneration.current) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setState("authenticated");
    } catch (cause) {
      await holdSpinner(startedAt);
      if (generation !== authRequestGeneration.current) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(authErrorMessage(cause, "Could not connect to this OpenTeam server"));
    } finally {
      if (generation === authRequestGeneration.current) {
        requestPending.current = false;
        setSubmitting(false);
      }
    }
  };

  const signInWithCredentials = async () => {
    if (signInDisabled || requestPending.current) return;
    requestPending.current = true;
    const generation = authRequestGeneration.current + 1;
    authRequestGeneration.current = generation;
    const startedAt = Date.now();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSubmitting(true);
    setError(null);
    try {
      await authenticateConnection(serverUrl, username, password);
      if (generation !== authRequestGeneration.current) return;
      await saveServerConnection({ serverUrl });
      await holdSpinner(startedAt);
      if (generation !== authRequestGeneration.current) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPassword("");
      setState("authenticated");
    } catch (cause) {
      await holdSpinner(startedAt);
      if (generation !== authRequestGeneration.current) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(authErrorMessage(cause, "Could not sign in to OpenTeam"));
    } finally {
      if (generation === authRequestGeneration.current) {
        requestPending.current = false;
        setSubmitting(false);
      }
    }
  };

  if (state === "authenticated") {
    return (
      <Animated.View style={{ flex: 1, transform: [{ translateY: appEntryOffset }] }}>
        {children}
      </Animated.View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: loginBackground }]}>
      <View style={styles.screen}>
        <BotField reduceMotion={reduceMotion} transitionProgress={stageProgress} />
        <Animated.View
          accessibilityElementsHidden={stage !== "welcome" && keyboardVisible}
          pointerEvents="none"
          style={[
            styles.hero,
            { transform: [{ translateY: heroTranslateY }, { scale: heroScale }] },
          ]}
        >
          <GlassSurface
            fallbackColor={cardFallback}
            style={[
              styles.heroCard,
              {
                borderColor: theme.border,
                shadowColor: theme.dark ? "#000000" : "#74746d",
              },
            ]}
          >
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
              OpenTeam
            </Text>
            <Text style={[styles.tagline, { color: glassSecondary }]}>
              Your team of always-on Bots{"\n"}that finish the work
            </Text>
          </GlassSurface>
        </Animated.View>

        {state === "checking" ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Checking session"
            style={styles.bottomArea}
          >
            <GlassSurface
              fallbackColor={actionBackground}
              style={[styles.primaryButton, { borderColor: theme.border }]}
              tintColor={primaryGlassTint}
            >
              <ActivityIndicator color={actionForeground} size="small" />
              <Text style={[styles.primaryButtonText, { color: actionForeground }]}>
                Checking session…
              </Text>
            </GlassSurface>
          </View>
        ) : (
          <>
            <Animated.View
              accessibilityElementsHidden={stage !== "welcome"}
              importantForAccessibility={stage === "welcome" ? "auto" : "no-hide-descendants"}
              pointerEvents={stage === "welcome" ? "auto" : "none"}
              style={[styles.bottomArea, { transform: [{ translateY: welcomeTranslateY }] }]}
            >
              <AuthNotice
                message={stage === "welcome" ? error : null}
                color={glassDanger}
                reduceMotion={reduceMotion}
              />
              <AuthButton
                reduceMotion={reduceMotion}
                accessibilityRole="button"
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setError(null);
                  setStage("endpoint");
                }}
                style={styles.primaryButtonHit}
              >
                <GlassSurface
                  fallbackColor={actionBackground}
                  interactive
                  style={[styles.primaryButton, { borderColor: theme.border }]}
                  tintColor={primaryGlassTint}
                >
                  <Text style={[styles.primaryButtonText, { color: actionForeground }]}>
                    Log In
                  </Text>
                </GlassSurface>
              </AuthButton>
            </Animated.View>
            {keyboardVisible ? (
              <Pressable
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                onPress={Keyboard.dismiss}
                style={styles.keyboardDismissLayer}
              />
            ) : null}
            <Animated.View
              accessibilityElementsHidden={stage !== "endpoint"}
              importantForAccessibility={stage === "endpoint" ? "auto" : "no-hide-descendants"}
              pointerEvents={stage === "endpoint" ? "auto" : "none"}
              style={[
                styles.panelLayer,
                {
                  transform: [{ translateX: endpointTranslateX }, { translateY: panelLift }],
                },
              ]}
            >
              <ScrollView
                bounces={false}
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: formMaxHeight, borderRadius: 30 }}
              >
                <GlassSurface
                  fallbackColor={cardFallback}
                  style={[
                    styles.credentialsPanel,
                    {
                      borderColor: theme.border,
                      shadowColor: theme.dark ? "#000000" : "#74746d",
                    },
                  ]}
                >
                  <View style={styles.endpointGroup}>
                    <View style={styles.accountHeader}>
                      <Text
                        accessibilityRole="header"
                        style={[styles.accountTitle, { color: theme.text }]}
                      >
                        Connect to your server
                      </Text>
                      <Text style={[styles.connectedServer, { color: glassSecondary }]}>
                        Use the server address from your OpenTeam setup.
                      </Text>
                    </View>
                    <Text style={[styles.endpointLabel, { color: glassLabel }]}>
                      SERVER ADDRESS
                    </Text>
                    <TextInput
                      accessibilityHint="Enter the HTTP or HTTPS address this device can use to reach your self-hosted OpenTeam server"
                      accessibilityLabel="Server address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardAppearance={theme.dark ? "dark" : "light"}
                      editable={stage === "endpoint" && !submitting}
                      keyboardType="url"
                      onChangeText={updateServerUrl}
                      onSubmitEditing={() => void connectToServer()}
                      placeholder="https://openteam.example.com"
                      placeholderTextColor={glassPlaceholder}
                      returnKeyType="go"
                      style={[
                        styles.input,
                        {
                          backgroundColor: fieldBackground,
                          borderColor: theme.border,
                          color: theme.text,
                        },
                      ]}
                      textContentType="URL"
                      value={serverUrl}
                    />
                  </View>
                  <AuthNotice
                    message={
                      stage === "endpoint"
                        ? [
                            error,
                            usesCleartextHttp
                              ? "HTTP is not encrypted. Only connect through a network or VPN you trust."
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n\n") || null
                        : null
                    }
                    color={error ? glassDanger : glassSecondary}
                    reduceMotion={reduceMotion}
                  />
                </GlassSurface>
              </ScrollView>
              <GlassGroup style={styles.actionRow}>
                <AuthButton
                  reduceMotion={reduceMotion}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: submitting }}
                  disabled={submitting}
                  onPress={() => {
                    Keyboard.dismiss();
                    setError(null);
                    setStage("welcome");
                  }}
                  style={styles.cancelButtonHit}
                >
                  <GlassSurface
                    fallbackColor={theme.dark ? "#343434" : "#e2e2df"}
                    interactive
                    style={[styles.cancelButton, { borderColor: theme.border }]}
                    tintColor={secondaryGlassTint}
                  >
                    <Text
                      style={[
                        styles.cancelButtonText,
                        { color: submitting ? mutedCancelForeground : theme.text },
                      ]}
                    >
                      Back
                    </Text>
                  </GlassSurface>
                </AuthButton>
                <AuthButton
                  reduceMotion={reduceMotion}
                  accessibilityRole="button"
                  accessibilityLabel={submitting ? "Connecting…" : "Connect"}
                  accessibilityState={{ disabled: connectDisabled, busy: submitting }}
                  disabled={connectDisabled}
                  onPress={() => void connectToServer()}
                  style={styles.signInButtonHit}
                >
                  <GlassSurface
                    fallbackColor={actionBackground}
                    interactive={!connectDisabled}
                    style={[
                      styles.signInButton,
                      { borderColor: connectDisabled ? theme.border : actionGlassBorder },
                    ]}
                    tintColor={connectDisabled ? disabledGlassTint : primaryGlassTint}
                  >
                    <AuthSubmitLabel
                      busy={submitting}
                      busyLabel="Connecting…"
                      idleLabel="Connect"
                      color={
                        connectDisabled && !submitting ? mutedActionForeground : actionForeground
                      }
                      reduceMotion={reduceMotion}
                    />
                  </GlassSurface>
                </AuthButton>
              </GlassGroup>
            </Animated.View>

            <Animated.View
              accessibilityElementsHidden={stage !== "credentials"}
              importantForAccessibility={stage === "credentials" ? "auto" : "no-hide-descendants"}
              pointerEvents={stage === "credentials" ? "auto" : "none"}
              style={[
                styles.panelLayer,
                {
                  transform: [{ translateX: credentialsTranslateX }, { translateY: panelLift }],
                },
              ]}
            >
              <ScrollView
                bounces={false}
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: formMaxHeight, borderRadius: 30 }}
              >
                <GlassSurface
                  fallbackColor={cardFallback}
                  style={[
                    styles.credentialsPanel,
                    {
                      borderColor: theme.border,
                      shadowColor: theme.dark ? "#000000" : "#74746d",
                    },
                  ]}
                >
                  <View style={styles.accountHeader}>
                    <Text style={[styles.endpointLabel, { color: glassLabel }]}>ACCOUNT</Text>
                    <Text style={[styles.accountTitle, { color: theme.text }]}>Sign in</Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.connectedServer, { color: glassSecondary }]}
                    >
                      {serverUrl}
                    </Text>
                  </View>
                  <TextInput
                    accessibilityLabel="Username"
                    autoCapitalize="none"
                    autoComplete="username"
                    autoCorrect={false}
                    keyboardAppearance={theme.dark ? "dark" : "light"}
                    editable={stage === "credentials" && !submitting}
                    onChangeText={updateUsername}
                    onSubmitEditing={() => passwordInput.current?.focus()}
                    submitBehavior="submit"
                    placeholder="Username"
                    placeholderTextColor={glassPlaceholder}
                    ref={usernameInput}
                    returnKeyType="next"
                    style={[
                      styles.input,
                      {
                        backgroundColor: fieldBackground,
                        borderColor: theme.border,
                        color: theme.text,
                      },
                    ]}
                    textContentType="username"
                    value={username}
                  />
                  <TextInput
                    accessibilityLabel="Password"
                    autoComplete="current-password"
                    keyboardAppearance={theme.dark ? "dark" : "light"}
                    editable={stage === "credentials" && !submitting}
                    onChangeText={updatePassword}
                    ref={passwordInput}
                    onSubmitEditing={() => void signInWithCredentials()}
                    placeholder="Password"
                    placeholderTextColor={glassPlaceholder}
                    returnKeyType="go"
                    secureTextEntry
                    style={[
                      styles.input,
                      {
                        backgroundColor: fieldBackground,
                        borderColor: theme.border,
                        color: theme.text,
                      },
                    ]}
                    textContentType="password"
                    value={password}
                  />
                  <AuthNotice
                    message={
                      stage === "credentials"
                        ? [
                            error,
                            usesCleartextHttp
                              ? "Your password will be sent without HTTPS protection."
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n\n") || null
                        : null
                    }
                    color={error ? glassDanger : glassSecondary}
                    reduceMotion={reduceMotion}
                  />
                </GlassSurface>
              </ScrollView>
              <GlassGroup style={styles.actionRow}>
                <AuthButton
                  reduceMotion={reduceMotion}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: submitting }}
                  disabled={submitting}
                  onPress={() => {
                    Keyboard.dismiss();
                    setError(null);
                    setPassword("");
                    setStage("endpoint");
                  }}
                  style={styles.cancelButtonHit}
                >
                  <GlassSurface
                    fallbackColor={theme.dark ? "#343434" : "#e2e2df"}
                    interactive
                    style={[styles.cancelButton, { borderColor: theme.border }]}
                    tintColor={secondaryGlassTint}
                  >
                    <Text
                      style={[
                        styles.cancelButtonText,
                        { color: submitting ? mutedCancelForeground : theme.text },
                      ]}
                    >
                      Back
                    </Text>
                  </GlassSurface>
                </AuthButton>
                <AuthButton
                  reduceMotion={reduceMotion}
                  accessibilityRole="button"
                  accessibilityLabel={submitting ? "Signing In…" : "Sign In"}
                  accessibilityState={{ disabled: signInDisabled, busy: submitting }}
                  disabled={signInDisabled}
                  onPress={() => void signInWithCredentials()}
                  style={styles.signInButtonHit}
                >
                  <GlassSurface
                    fallbackColor={actionBackground}
                    interactive={!signInDisabled}
                    style={[
                      styles.signInButton,
                      { borderColor: signInDisabled ? theme.border : actionGlassBorder },
                    ]}
                    tintColor={signInDisabled ? disabledGlassTint : primaryGlassTint}
                  >
                    <AuthSubmitLabel
                      busy={submitting}
                      busyLabel="Signing In…"
                      idleLabel="Sign In"
                      color={
                        signInDisabled && !submitting ? mutedActionForeground : actionForeground
                      }
                      reduceMotion={reduceMotion}
                    />
                  </GlassSurface>
                </AuthButton>
              </GlassGroup>
            </Animated.View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, overflow: "hidden" },
  screen: { flex: 1 },
  botField: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
  },
  hero: {
    position: "absolute",
    left: 24,
    right: 24,
    top: 48,
    alignItems: "center",
  },
  heroCard: {
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 28,
    minWidth: 292,
    paddingHorizontal: 28,
    paddingVertical: 20,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
  },
  title: { fontSize: 34, lineHeight: 41, fontWeight: "600", letterSpacing: -0.8 },
  tagline: { marginTop: 13, textAlign: "center", fontSize: 16, lineHeight: 21 },
  bottomArea: { position: "absolute", left: 26, right: 26, bottom: 14 },
  primaryButtonHit: { minHeight: 58, borderRadius: 29, marginTop: 8 },
  primaryButton: {
    minHeight: 58,
    borderRadius: 29,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 22,
  },
  primaryButtonText: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  keyboardDismissLayer: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  panelLayer: {
    position: "absolute",
    right: 18,
    bottom: 12,
    left: 18,
    gap: 10,
  },
  credentialsPanel: {
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 30,
    padding: 16,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 26,
  },
  accountHeader: { gap: 3, paddingHorizontal: 4, paddingBottom: 2 },
  accountTitle: { fontSize: 24, lineHeight: 30, fontWeight: "600", letterSpacing: -0.35 },
  connectedServer: { fontSize: 12, lineHeight: 16 },
  endpointGroup: { gap: 6 },
  endpointLabel: {
    paddingHorizontal: 4,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  input: {
    minHeight: 52,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  error: { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 },
  actionRow: { flexDirection: "row", gap: 10 },
  cancelButtonHit: { height: 58, minWidth: 94, borderRadius: 29 },
  cancelButton: {
    width: "100%",
    height: "100%",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  cancelButtonText: { fontSize: 17, lineHeight: 22, fontWeight: "500" },
  signInButtonHit: { height: 58, flex: 1, borderRadius: 29 },
  signInButton: {
    width: "100%",
    height: "100%",
    borderRadius: 29,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingHorizontal: 18,
  },
  // Never dim these with opacity. A glass surface whose ancestor sits below alpha 1 when the
  // effect installs renders permanently flat, and Connect mounts disabled.
  submitLabel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
});
