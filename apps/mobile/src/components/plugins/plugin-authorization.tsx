import type { PluginConnectionView } from "@openteam/contracts";
import { pluginAuthorization } from "@openteam/product-core/plugin-authorization";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useEffect, useRef, useState } from "react";
import { Linking, Text, TextInput, View } from "react-native";
import { useOpenTeam } from "../../state/openteam-context";
import { useTheme } from "../../theme";
import { NativeActionButton } from "../native-controls";

export function PluginAuthorization({
  connection,
  refresh,
}: {
  connection: PluginConnectionView;
  refresh: () => Promise<unknown>;
}) {
  const { pluginOperation } = useOpenTeam();
  const theme = useTheme();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  useEffect(() => setCallbackUrl(""), [connection.authorizationUrl]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!connection.authorizationUrl) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connection.authorizationUrl]);
  const session = pluginAuthorization(connection, now);
  useEffect(() => { if (session?.expired) setCallbackUrl(""); }, [session?.expired]);
  if (!session) return null;
  const run = async (action: () => Promise<unknown>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(clientErrorMessage(cause, "Sign-in could not continue. Try again."));
      await refresh().catch(() => undefined);
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8, paddingVertical: 12 }}>
      <Text style={{ color: theme.text, fontWeight: "600" }}>
        {session.expired ? "Sign-in expired" : "Finish signing in"}
      </Text>
      <Text style={{ color: theme.textMuted }}>
        {session.expired
          ? "Start again when you’re ready. Your setup is saved."
          : "Approve access in your browser, then return to OpenTeam."}
      </Text>
      {connection.oauthCallbackMode === "manual" && !session.expired && <View style={{ gap: 8 }}>
        <Text style={{ color: theme.textMuted }}>The browser’s final page may say it cannot open. This is expected. Tap the address bar, copy the entire address starting with 127.0.0.1, return here, and paste it below.</Text>
        <TextInput accessibilityLabel="Browser address from sign-in" placeholder="Paste the browser address here" value={callbackUrl} onChangeText={setCallbackUrl} secureTextEntry autoCapitalize="none" autoCorrect={false} style={{ color: theme.text, padding: 12 }} />
        <NativeActionButton title="Complete sign-in" disabled={busy || !callbackUrl.trim()} onPress={() => { const value = callbackUrl; setCallbackUrl(""); void run(() => pluginOperation(api => api.finishManualPluginAuthentication(connection.id, value))); }} />
      </View>}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.danger }}>
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <NativeActionButton
          title={session.expired ? "Try again" : "Reopen sign-in"}
          disabled={busy}
          onPress={() =>
            void run(async () => {
              const url = session.expired
                ? (await pluginOperation((api) => api.authenticatePlugin(connection.id)))
                    .authorizationUrl
                : session.url;
              await Linking.openURL(url);
            })
          }
        />
        <NativeActionButton
          title="Cancel sign-in"
          disabled={busy}
          onPress={() =>
            void run(() =>
              pluginOperation((api) => api.cancelPluginAuthentication(connection.id, session.state))
            )
          }
        />
      </View>
    </View>
  );
}
