import type { OpenBotAuthStatus } from "@openbot/client-core/auth";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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
} from "../auth";
import { loadServerConnection, saveServerConnection } from "../server-config";
import { useTheme } from "../theme";
import { BotMark } from "./bot-mark";

type SignInStage = "welcome" | "credentials";

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

function BotField({ compact }: { compact: boolean }) {
  const { width, height } = useWindowDimensions();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.botField}
    >
      {decorations.map((decoration, index) => {
        if (compact && index >= 6) return null;
        const size = width * decoration.size;
        return (
          <View
            key={`${decoration.icon}-${decoration.color}`}
            style={{
              left: width * decoration.left,
              position: "absolute",
              top: height * decoration.top,
              transform: [{ rotate: decoration.rotate }],
            }}
          >
            <BotMark
              color={decoration.color}
              faceColor="#111111"
              icon={decoration.icon}
              size={size}
            />
          </View>
        );
      })}
    </View>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [state, setState] = useState<OpenBotAuthStatus>("checking");
  const [stage, setStage] = useState<SignInStage>("welcome");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const authRequestGeneration = useRef(0);
  const loginBackground = theme.dark ? "#101010" : "#f5f5f3";
  const actionBackground = theme.dark ? "#ffffff" : "#111111";
  const actionForeground = theme.dark ? "#111111" : "#ffffff";
  const hasUsername = username.trim().length > 0;
  const hasPassword = password.length > 0;
  const hasCompleteCredentials = hasUsername && hasPassword;
  const hasPartialCredentials = hasUsername !== hasPassword;
  const submitDisabled = submitting || !serverUrl.trim() || hasPartialCredentials;
  const updateServerUrl = (value: string) => {
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
    let cancelled = false;
    const unsubscribe = onAuthenticationRequired(() => {
      const generation = authRequestGeneration.current + 1;
      authRequestGeneration.current = generation;
      const configured = getConfiguredAuthServer();
      if (!configured) {
        setStage("credentials");
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
        setError(clientErrorMessage(cause, "Could not load the OpenBot server"));
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

  const submit = async () => {
    if (submitDisabled) return;
    const generation = authRequestGeneration.current + 1;
    authRequestGeneration.current = generation;
    setSubmitting(true);
    setError(null);
    try {
      const connection = await saveServerConnection({ serverUrl });
      setServerUrl(connection.serverUrl);
      await authenticateConnection(connection.serverUrl, username, password);
      if (generation !== authRequestGeneration.current) return;
      setPassword("");
      setState("authenticated");
    } catch (cause) {
      if (generation !== authRequestGeneration.current) return;
      setError(clientErrorMessage(cause, "Could not sign in to OpenBot"));
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
        <BotField compact={stage === "credentials"} />
        <View
          accessibilityElementsHidden={stage === "credentials" && keyboardVisible}
          pointerEvents="none"
          style={[
            styles.hero,
            stage === "credentials" && styles.credentialsHero,
            stage === "credentials" && keyboardVisible && styles.keyboardHiddenHero,
          ]}
        >
          <Text style={[styles.title, { color: theme.text }]}>OpenBot</Text>
          <Text style={[styles.tagline, { color: theme.textMuted }]}>
            Your team of always-on Bots{"\n"}that finish the work
          </Text>
        </View>

        {state === "checking" ? (
          <View style={styles.bottomArea}>
            <View style={[styles.primaryButton, { backgroundColor: actionBackground }]}>
              <ActivityIndicator color={actionForeground} size="small" />
              <Text style={[styles.primaryButtonText, { color: actionForeground }]}>
                Checking session…
              </Text>
            </View>
          </View>
        ) : stage === "welcome" ? (
          <View style={styles.bottomArea}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setStage("credentials")}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: actionBackground, opacity: pressed ? 0.78 : 1 },
              ]}
            >
              <Text style={[styles.primaryButtonText, { color: actionForeground }]}>Log In</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={styles.credentialsScroll}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.credentialsScrollView}
          >
            <View style={styles.credentialsPanel}>
              <View style={styles.endpointGroup}>
                <Text style={[styles.endpointLabel, { color: theme.textMuted }]}>
                  SERVER ENDPOINT
                </Text>
                <TextInput
                  accessibilityHint="Enter the HTTP or HTTPS address this device can use to reach your self-hosted OpenBot server"
                  accessibilityLabel="Server endpoint"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={updateServerUrl}
                  placeholder="https://openbot.example.com"
                  placeholderTextColor={theme.textFaint}
                  style={[
                    styles.input,
                    { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                  ]}
                  textContentType="URL"
                  value={serverUrl}
                />
                <Text style={[styles.endpointHint, { color: theme.textFaint }]}>
                  Address reachable from this device. Use HTTPS except for trusted local
                  development.
                </Text>
              </View>
              <TextInput
                accessibilityLabel="Username"
                autoCapitalize="none"
                autoComplete="username"
                autoCorrect={false}
                autoFocus={Boolean(serverUrl)}
                onChangeText={updateUsername}
                placeholder="Username"
                placeholderTextColor={theme.textFaint}
                returnKeyType="next"
                style={[
                  styles.input,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                textContentType="username"
                value={username}
              />
              <TextInput
                accessibilityLabel="Password"
                autoComplete="current-password"
                onChangeText={updatePassword}
                onSubmitEditing={() => void submit()}
                placeholder="Password"
                placeholderTextColor={theme.textFaint}
                returnKeyType="go"
                secureTextEntry
                style={[
                  styles.input,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                textContentType="password"
                value={password}
              />
              {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={submitting}
                  onPress={() => {
                    setError(null);
                    setPassword("");
                    setStage("welcome");
                  }}
                  style={({ pressed }) => [
                    styles.cancelButton,
                    {
                      backgroundColor: theme.dark ? "#343434" : "#e2e2df",
                      borderColor: theme.border,
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={submitDisabled}
                  onPress={() => void submit()}
                  style={({ pressed }) => [
                    styles.signInButton,
                    {
                      backgroundColor: actionBackground,
                      opacity: submitDisabled ? 0.5 : pressed ? 0.78 : 1,
                    },
                  ]}
                >
                  {submitting ? <ActivityIndicator color={actionForeground} size="small" /> : null}
                  <Text style={[styles.primaryButtonText, { color: actionForeground }]}>
                    {submitting
                      ? hasCompleteCredentials
                        ? "Signing In…"
                        : "Connecting…"
                      : hasCompleteCredentials
                        ? "Sign In"
                        : "Connect"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
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
    top: "42%",
    alignItems: "center",
  },
  credentialsHero: { top: 48 },
  keyboardHiddenHero: { opacity: 0 },
  title: { fontSize: 34, lineHeight: 41, fontWeight: "600", letterSpacing: -0.8 },
  tagline: { marginTop: 13, textAlign: "center", fontSize: 16, lineHeight: 21 },
  bottomArea: { position: "absolute", left: 26, right: 26, bottom: 14 },
  primaryButton: {
    minHeight: 58,
    borderRadius: 29,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 22,
  },
  primaryButtonText: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  credentialsScrollView: { flex: 1 },
  credentialsScroll: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 26,
    paddingTop: 260,
    paddingBottom: 14,
  },
  credentialsPanel: { gap: 10 },
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
  cancelButton: {
    height: 58,
    minWidth: 94,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  cancelButtonText: { fontSize: 17, lineHeight: 22, fontWeight: "500" },
  signInButton: {
    height: 58,
    flex: 1,
    borderRadius: 29,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingHorizontal: 18,
  },
});
