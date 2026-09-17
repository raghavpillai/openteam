import type { PluginConnectionView } from "@openteam/contracts";
import { pluginAuthorization } from "@openteam/product-core/plugin-authorization";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
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
  const [error, setError] = useState("");
  useEffect(() => {
    if (!connection.authorizationUrl) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connection.authorizationUrl]);
  const session = pluginAuthorization(connection, now);
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
        {session.expired ? "Sign-in expired" : "Waiting for authorization"}
      </Text>
      <Text style={{ color: theme.textMuted }}>
        {session.expired
          ? "Start again when you’re ready. Your setup is saved."
          : "Finish in your browser, or reopen the same sign-in."}
      </Text>
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
