/** Disposable simulator entry; no accounts, live approvals, or credential values. */
import { registerRootComponent } from "expo";
import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppearanceProvider, useAppearance } from "../src/appearance";
import { OpenTeamProvider } from "../src/state/openteam-context";
import { MobileRichMessageCard } from "../src/components/rich-message-card";
import { ApprovalCard } from "../src/components/approval-card";
import { useTheme } from "../src/theme";
import type { ApprovalView, ChannelMessageView } from "@openteam/contracts";
const control = "http://127.0.0.1:8094";
function Fixture() {
  const [state, setState] = useState<{
    id: string;
    theme: "light" | "dark";
    approval?: ApprovalView;
    message?: ChannelMessageView;
  } | null>(null);
  const { setPreference } = useAppearance();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    let active = true;
    let last = "";
    const poll = async () => {
      try {
        const next = await (await fetch(control + "/state")).json();
        if (active && JSON.stringify(next) !== last) {
          last = JSON.stringify(next);
          setState(next);
          await setPreference(next.theme);
          await fetch(control + "/rendered", {
            method: "POST",
            body: JSON.stringify({ id: next.id }),
          });
        }
      } catch {
        /* The local harness may be restarting. */
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 300);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [setPreference]);
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: theme.background }}>
      <Text style={{ color: theme.textMuted, padding: 18 }}>
        Permission QA · {state?.id ?? "Loading"}
      </Text>
      <ScrollView>
        {state?.message && (
          <MobileRichMessageCard
            message={state.message}
            onWidgetResponse={async () => true}
            onWidgetDismiss={async () => true}
            onSecretSubmit={async () => true}
            onComputerHandoff={async () => true}
          />
        )}
        {state?.approval && (
          <ApprovalCard
            key={state.id}
            approval={state.approval}
            onResolve={async (decision, selectedItems) => {
              await fetch(control + "/decision", {
                method: "POST",
                body: JSON.stringify({ id: state.id, decision, selectedItems }),
              });
            }}
          />
        )}
      </ScrollView>
    </View>
  );
}
registerRootComponent(() => (
  <SafeAreaProvider>
    <AppearanceProvider>
      <OpenTeamProvider>
        <Fixture />
      </OpenTeamProvider>
    </AppearanceProvider>
  </SafeAreaProvider>
));
