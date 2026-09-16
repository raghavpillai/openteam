import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppearanceProvider } from "../../../src/appearance";
import { OpenTeamProvider } from "../../../src/state/openteam-context";

export default function ReadmeLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppearanceProvider>
          <StatusBar style="dark" />
          <OpenTeamProvider>
            <Stack screenOptions={{ headerShown: false }} />
          </OpenTeamProvider>
        </AppearanceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
