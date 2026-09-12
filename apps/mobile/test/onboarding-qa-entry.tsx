// Dedicated Metro entry for a disposable simulator; the production AuthGate is unchanged.
import { registerRootComponent } from "expo";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppearanceProvider, useAppearance } from "../src/appearance";
import { AuthGate } from "../src/components/auth-gate";
import { configureAuthServer, signOut } from "../src/auth";
import { saveServerConnection } from "../src/server-config";
function QA() {
  const { dark, setPreference } = useAppearance();
  const insets = useSafeAreaInsets();
  const [nonce, setNonce] = useState(0);
  const reset = async () => {
    await signOut();
    await saveServerConnection({ serverUrl: "" });
    configureAuthServer(null);
    setNonce((n) => n + 1);
  };
  return (
    <View style={{ flex: 1 }}>
      <AuthGate key={nonce}>
        <View
          style={{
            flex: 1,
            paddingTop: 150,
            alignItems: "center",
            backgroundColor: dark ? "#111" : "#fff",
          }}
        >
          <Text style={{ fontSize: 24, color: dark ? "white" : "black" }}>
            Signed in successfully
          </Text>
          <Pressable onPress={() => void reset()} style={{ padding: 20 }}>
            <Text style={{ color: "#007aff" }}>Sign out and reset</Text>
          </Pressable>
        </View>
      </AuthGate>
      <View
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          top: insets.top + 4,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <Text style={{ fontSize: 11, color: dark ? "#aaa" : "#555" }}>Onboarding QA</Text>
        <Pressable onPress={() => void setPreference(dark ? "light" : "dark")}>
          <Text style={{ fontSize: 12, color: "#007aff" }}>
            {dark ? "Light" : "Dark"} appearance
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
function App() {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <QA />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}
registerRootComponent(App);
