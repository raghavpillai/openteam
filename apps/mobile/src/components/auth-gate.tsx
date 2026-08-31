import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { hasValidSession, onAuthenticationRequired, serverUrl, signIn } from "../auth";
import { useTheme } from "../theme";

export function AuthGate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [state, setState] = useState<"checking" | "signed-out" | "signed-in">(
    serverUrl ? "checking" : "signed-in"
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!serverUrl) return;
    let cancelled = false;
    void hasValidSession().then((valid) => {
      if (!cancelled) setState(valid ? "signed-in" : "signed-out");
    });
    const unsubscribe = onAuthenticationRequired(() => setState("signed-out"));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const submit = async () => {
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(username, password);
      setPassword("");
      setState("signed-in");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in to OpenBot");
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "signed-in") return children;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      {state === "checking" ? (
        <ActivityIndicator color={theme.textMuted} />
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.keyboard}
        >
          <Text style={[styles.title, { color: theme.text }]}>Sign in to OpenBot</Text>
          <Text style={[styles.copy, { color: theme.textMuted }]}>
            Enter the server owner account.
          </Text>
          <Text style={[styles.label, { color: theme.textMuted }]}>Username</Text>
          <TextInput
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect={false}
            onChangeText={setUsername}
            returnKeyType="next"
            style={[
              styles.input,
              { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
            ]}
            textContentType="username"
            value={username}
          />
          <Text style={[styles.label, { color: theme.textMuted }]}>Password</Text>
          <TextInput
            autoComplete="current-password"
            onChangeText={setPassword}
            onSubmitEditing={() => void submit()}
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
          <Pressable
            accessibilityRole="button"
            disabled={submitting || !username.trim() || !password}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.text, opacity: submitting ? 0.55 : pressed ? 0.75 : 1 },
            ]}
          >
            {submitting ? (
              <ActivityIndicator color={theme.background} />
            ) : (
              <Text style={[styles.buttonText, { color: theme.background }]}>Sign in</Text>
            )}
          </Pressable>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: "center" },
  keyboard: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.7 },
  copy: { fontSize: 15, lineHeight: 20, marginTop: 5, marginBottom: 20 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600", marginTop: 8, marginBottom: 5 },
  input: {
    height: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 13,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  error: { fontSize: 13, lineHeight: 18, marginTop: 8 },
  button: {
    height: 48,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
  },
  buttonText: { fontSize: 16, lineHeight: 20, fontWeight: "700" },
});
