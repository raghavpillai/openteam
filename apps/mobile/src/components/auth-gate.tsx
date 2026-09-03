import type { OpenTeamAuthStatus } from "@openteam/client-core/auth";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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
import { GlassSurface } from "./glass-surface";

type SignInStage = "welcome" | "endpoint" | "credentials";

const decorations = [
  { color: "#08c875", icon: "cloud", left: 0.18, size: 0.205, top: 0.11, rotate: "-8deg" },
  { color: "#f72591", icon: "drop", left: 0.57, size: 0.16, top: 0.17, rotate: "18deg" },
  { color: "#8850f5", icon: "pill", left: -0.02, size: 0.14, top: 0.31, rotate: "80deg" },
  { color: "#9d683e", icon: "circle", left: 0.88, size: 0.16, top: 0.31, rotate: "-22deg" },
  { color: "#ff9912", icon: "circle", left: -0.09, size: 0.2, top: 0.5, rotate: "15deg" },
  { color: "#ff2445", icon: "circle", left: 0.93, size: 0.2, top: 0.51, rotate: "-22deg" },
  { color: "#1685ed", icon: "square", left: 0.03, size: 0.18, top: 0.7, rotate: "4deg" },
  { color: "#08bca9", icon: "circle", left: 0.8, size: 0.16, top: 0.7, rotate: "-18deg" },
  { color: "#ff6811", icon: "hexagon", left: 0.36, size: 0.21, top: 0.76, rotate: "4deg" },
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
        const fadesForCredentials = index >= 6;
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
              fadesForCredentials && {
                opacity: transitionProgress.interpolate({
                  inputRange: [0, 0.55],
                  outputRange: [1, 0],
                  extrapolate: "clamp",
                }),
                transform: [
                  { rotate: decoration.rotate },
                  {
                    scale: transitionProgress.interpolate({
                      inputRange: [0, 0.55],
                      outputRange: [1, 0.82],
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
  const { height } = useWindowDimensions();
  const [state, setState] = useState<OpenTeamAuthStatus>("checking");
  const [stage, setStage] = useState<SignInStage>("welcome");
  const [authFlowMounted, setAuthFlowMounted] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const authRequestGeneration = useRef(0);
  const usernameInput = useRef<TextInput>(null);
  const stageProgress = useRef(new Animated.Value(0)).current;
  const keyboardProgress = useRef(new Animated.Value(0)).current;
  const loginBackground = theme.dark ? "#101010" : "#f5f5f3";
  const actionBackground = theme.dark ? "#ffffff" : "#111111";
  const actionForeground = theme.dark ? "#111111" : "#ffffff";
  const actionGlassFill = theme.dark ? "rgba(255,255,255,0.58)" : "rgba(17,17,17,0.64)";
  const actionGlassBorder = theme.dark ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.24)";
  const disabledActionBackground = theme.dark ? "rgba(255,255,255,0.22)" : "rgba(17,17,17,0.2)";
  const cardFallback = theme.dark ? "rgba(35,35,35,0.92)" : "rgba(255,255,255,0.84)";
  const fieldBackground = theme.dark ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.56)";
  const primaryGlassTint = theme.dark ? "rgba(255,255,255,0.82)" : "rgba(17,17,17,0.78)";
  const secondaryGlassTint = theme.dark ? "rgba(58,58,58,0.58)" : "rgba(255,255,255,0.42)";
  const hasUsername = username.trim().length > 0;
  const hasPassword = password.length > 0;
  const hasCompleteCredentials = hasUsername && hasPassword;
  const connectDisabled = submitting || !serverUrl.trim();
  const signInDisabled = submitting || !hasCompleteCredentials;
  const renderAuthFlow = stage !== "welcome" || authFlowMounted;
  const stageTarget = stage === "welcome" ? 0 : stage === "endpoint" ? 1 : 2;
  const welcomeHeroOffset = Math.max(0, height * 0.42 - 48);
  const heroTranslateY = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [welcomeHeroOffset, 0, 0],
  });
  const heroScale = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [1, 0.96, 0.96],
  });
  const heroOpacity = keyboardProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });
  const welcomeOpacity = stageProgress.interpolate({
    inputRange: [0, 0.55, 1, 2],
    outputRange: [1, 0, 0, 0],
  });
  const welcomeTranslateY = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [0, 18, 18],
  });
  const endpointOpacity = stageProgress.interpolate({
    inputRange: [0, 0.18, 1, 2],
    outputRange: [0, 0, 1, 0],
  });
  const endpointTranslateX = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [32, 0, -28],
  });
  const credentialsOpacity = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [0, 0, 1],
  });
  const credentialsTranslateX = stageProgress.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [32, 32, 0],
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
    if (stage !== "welcome") setAuthFlowMounted(true);
    const animation = Animated.timing(stageProgress, {
      toValue: stageTarget,
      duration: reduceMotion ? 0 : stage === "welcome" ? 320 : stage === "endpoint" ? 420 : 340,
      easing: stage === "welcome" ? Easing.inOut(Easing.cubic) : Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      if (stage === "welcome") setAuthFlowMounted(false);
      if (stage === "credentials") usernameInput.current?.focus();
    });
    return () => animation.stop();
  }, [reduceMotion, stage, stageProgress, stageTarget]);

  useEffect(() => {
    const animation = Animated.timing(keyboardProgress, {
      toValue: stage === "credentials" && keyboardVisible ? 1 : 0,
      duration: reduceMotion ? 0 : 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [keyboardProgress, keyboardVisible, reduceMotion, stage]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAuthenticationRequired(() => {
      const generation = authRequestGeneration.current + 1;
      authRequestGeneration.current = generation;
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
        setError(clientErrorMessage(cause, "Could not load the OpenTeam server"));
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
    const show = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const connectToServer = async () => {
    if (connectDisabled) return;
    const generation = authRequestGeneration.current + 1;
    authRequestGeneration.current = generation;
    setSubmitting(true);
    setError(null);
    try {
      const normalized = normalizeServerConnection({ serverUrl });
      const result = await testServerConnection(normalized.serverUrl);
      if (generation !== authRequestGeneration.current) return;
      setServerUrl(normalized.serverUrl);
      if (result === "credentials-required") {
        setStage("credentials");
        return;
      }
      await saveServerConnection(normalized);
      if (generation !== authRequestGeneration.current) return;
      setState("authenticated");
    } catch (cause) {
      if (generation !== authRequestGeneration.current) return;
      setError(clientErrorMessage(cause, "Could not connect to this OpenTeam server"));
    } finally {
      if (generation === authRequestGeneration.current) setSubmitting(false);
    }
  };

  const signInWithCredentials = async () => {
    if (signInDisabled) return;
    const generation = authRequestGeneration.current + 1;
    authRequestGeneration.current = generation;
    setSubmitting(true);
    setError(null);
    try {
      await authenticateConnection(serverUrl, username, password);
      if (generation !== authRequestGeneration.current) return;
      await saveServerConnection({ serverUrl });
      if (generation !== authRequestGeneration.current) return;
      setPassword("");
      setState("authenticated");
    } catch (cause) {
      if (generation !== authRequestGeneration.current) return;
      setError(clientErrorMessage(cause, "Could not sign in to OpenTeam"));
    } finally {
      if (generation === authRequestGeneration.current) setSubmitting(false);
    }
  };

  if (state === "authenticated") return children;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: loginBackground }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.screen}
      >
        <BotField reduceMotion={reduceMotion} transitionProgress={stageProgress} />
        <Animated.View
          accessibilityElementsHidden={stage === "credentials" && keyboardVisible}
          pointerEvents="none"
          style={[
            styles.hero,
            {
              opacity: heroOpacity,
              transform: [{ translateY: heroTranslateY }, { scale: heroScale }],
            },
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
            <Text style={[styles.title, { color: theme.text }]}>OpenTeam</Text>
            <Text style={[styles.tagline, { color: theme.textMuted }]}>
              Your team of always-on Bots{"\n"}that finish the work
            </Text>
          </GlassSurface>
        </Animated.View>

        {state === "checking" ? (
          <View style={styles.bottomArea}>
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
              style={[
                styles.bottomArea,
                { opacity: welcomeOpacity, transform: [{ translateY: welcomeTranslateY }] },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                onPress={() => setStage("endpoint")}
                style={({ pressed }) => [styles.primaryButtonHit, pressed && styles.controlPressed]}
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
              </Pressable>
            </Animated.View>
            {renderAuthFlow ? (
              <>
                <Animated.ScrollView
                  accessibilityElementsHidden={stage !== "endpoint"}
                  automaticallyAdjustKeyboardInsets
                  contentContainerStyle={styles.credentialsScroll}
                  importantForAccessibility={stage === "endpoint" ? "auto" : "no-hide-descendants"}
                  keyboardDismissMode="interactive"
                  keyboardShouldPersistTaps="handled"
                  pointerEvents={stage === "endpoint" ? "auto" : "none"}
                  showsVerticalScrollIndicator={false}
                  style={[
                    styles.credentialsScrollView,
                    {
                      opacity: endpointOpacity,
                      transform: [{ translateX: endpointTranslateX }],
                    },
                  ]}
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
                      <Text style={[styles.endpointLabel, { color: theme.textMuted }]}>
                        SERVER ENDPOINT
                      </Text>
                      <TextInput
                        accessibilityHint="Enter the HTTP or HTTPS address this device can use to reach your self-hosted OpenTeam server"
                        accessibilityLabel="Server endpoint"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardAppearance={theme.dark ? "dark" : "light"}
                        keyboardType="url"
                        onChangeText={updateServerUrl}
                        onSubmitEditing={() => void connectToServer()}
                        placeholder="https://openteam.example.com"
                        placeholderTextColor={theme.textFaint}
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
                      <Text style={[styles.endpointHint, { color: theme.textFaint }]}>
                        Address reachable from this device. Connect verifies it before continuing.
                        Use HTTPS except for trusted local development.
                      </Text>
                    </View>
                    {stage === "endpoint" && error ? (
                      <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>
                    ) : null}
                    <View style={styles.actionRow}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={submitting}
                        onPress={() => {
                          Keyboard.dismiss();
                          setError(null);
                          setStage("welcome");
                        }}
                        style={({ pressed }) => [
                          styles.cancelButtonHit,
                          pressed && styles.controlPressed,
                          submitting && styles.controlDisabled,
                        ]}
                      >
                        <GlassSurface
                          fallbackColor={theme.dark ? "#343434" : "#e2e2df"}
                          interactive
                          style={[styles.cancelButton, { borderColor: theme.border }]}
                          tintColor={secondaryGlassTint}
                        >
                          <Text style={[styles.cancelButtonText, { color: theme.text }]}>
                            Cancel
                          </Text>
                        </GlassSurface>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={connectDisabled}
                        onPress={() => void connectToServer()}
                        style={({ pressed }) => [
                          styles.signInButtonHit,
                          connectDisabled && styles.controlDisabled,
                          pressed && !connectDisabled && styles.controlPressed,
                        ]}
                      >
                        <GlassSurface
                          fallbackColor={actionBackground}
                          interactive={!connectDisabled}
                          style={[
                            styles.signInButton,
                            {
                              backgroundColor: connectDisabled
                                ? disabledActionBackground
                                : actionGlassFill,
                              borderColor: connectDisabled ? theme.border : actionGlassBorder,
                            },
                          ]}
                          tintColor={primaryGlassTint}
                        >
                          {submitting ? (
                            <ActivityIndicator color={actionForeground} size="small" />
                          ) : null}
                          <Text style={[styles.primaryButtonText, { color: actionForeground }]}>
                            {submitting ? "Connecting…" : "Connect"}
                          </Text>
                        </GlassSurface>
                      </Pressable>
                    </View>
                  </GlassSurface>
                </Animated.ScrollView>

                <Animated.ScrollView
                  accessibilityElementsHidden={stage !== "credentials"}
                  automaticallyAdjustKeyboardInsets
                  contentContainerStyle={styles.credentialsScroll}
                  importantForAccessibility={
                    stage === "credentials" ? "auto" : "no-hide-descendants"
                  }
                  keyboardDismissMode="interactive"
                  keyboardShouldPersistTaps="handled"
                  pointerEvents={stage === "credentials" ? "auto" : "none"}
                  showsVerticalScrollIndicator={false}
                  style={[
                    styles.credentialsScrollView,
                    {
                      opacity: credentialsOpacity,
                      transform: [{ translateX: credentialsTranslateX }],
                    },
                  ]}
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
                      <Text style={[styles.endpointLabel, { color: theme.textMuted }]}>
                        ACCOUNT
                      </Text>
                      <Text style={[styles.accountTitle, { color: theme.text }]}>Sign in</Text>
                      <Text
                        numberOfLines={1}
                        style={[styles.connectedServer, { color: theme.textFaint }]}
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
                      onChangeText={updateUsername}
                      placeholder="Username"
                      placeholderTextColor={theme.textFaint}
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
                      onChangeText={updatePassword}
                      onSubmitEditing={() => void signInWithCredentials()}
                      placeholder="Password"
                      placeholderTextColor={theme.textFaint}
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
                    {stage === "credentials" && error ? (
                      <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>
                    ) : null}
                    <View style={styles.actionRow}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={submitting}
                        onPress={() => {
                          Keyboard.dismiss();
                          setError(null);
                          setPassword("");
                          setStage("endpoint");
                        }}
                        style={({ pressed }) => [
                          styles.cancelButtonHit,
                          pressed && styles.controlPressed,
                          submitting && styles.controlDisabled,
                        ]}
                      >
                        <GlassSurface
                          fallbackColor={theme.dark ? "#343434" : "#e2e2df"}
                          interactive
                          style={[styles.cancelButton, { borderColor: theme.border }]}
                          tintColor={secondaryGlassTint}
                        >
                          <Text style={[styles.cancelButtonText, { color: theme.text }]}>Back</Text>
                        </GlassSurface>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={signInDisabled}
                        onPress={() => void signInWithCredentials()}
                        style={({ pressed }) => [
                          styles.signInButtonHit,
                          signInDisabled && styles.controlDisabled,
                          pressed && !signInDisabled && styles.controlPressed,
                        ]}
                      >
                        <GlassSurface
                          fallbackColor={actionBackground}
                          interactive={!signInDisabled}
                          style={[styles.signInButton, { borderColor: theme.border }]}
                          tintColor={primaryGlassTint}
                        >
                          {submitting ? (
                            <ActivityIndicator color={actionForeground} size="small" />
                          ) : null}
                          <Text style={[styles.primaryButtonText, { color: actionForeground }]}>
                            {submitting ? "Signing In…" : "Sign In"}
                          </Text>
                        </GlassSurface>
                      </Pressable>
                    </View>
                  </GlassSurface>
                </Animated.ScrollView>
              </>
            ) : null}
          </>
        )}
      </KeyboardAvoidingView>
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
  primaryButtonHit: { minHeight: 58, borderRadius: 29 },
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
  credentialsScrollView: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  credentialsScroll: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 18,
    paddingTop: 260,
    paddingBottom: 12,
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
  endpointHint: { paddingHorizontal: 4, fontSize: 12, lineHeight: 16 },
  input: {
    height: 52,
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
  controlPressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  controlDisabled: { opacity: 0.5 },
});
