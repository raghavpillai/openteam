import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { OpenBotProvider } from "../src/state/openbot-context";
import { darkTheme, lightTheme } from "../src/theme";

export default function RootLayout() {
  const dark = useColorScheme() === "dark";
  const tokens = dark ? darkTheme : lightTheme;
  const navigationTheme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme.colors : DefaultTheme.colors),
      background: tokens.background,
      card: tokens.background,
      text: tokens.text,
      border: tokens.separator,
      primary: tokens.text,
      notification: tokens.accent,
    },
  };
  return (
    <SafeAreaProvider>
      <OpenBotProvider>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style={dark ? "light" : "dark"} />
          <Stack
            screenOptions={{
              headerShadowVisible: false,
              headerStyle: { backgroundColor: tokens.background },
              headerTintColor: tokens.text,
              contentStyle: { backgroundColor: tokens.background },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="chat/[channelId]" options={{ headerShown: false }} />
            <Stack.Screen name="computer/[botId]" options={{ headerShown: false }} />
            <Stack.Screen name="search" options={{ headerShown: false, presentation: "modal" }} />
          </Stack>
        </ThemeProvider>
      </OpenBotProvider>
    </SafeAreaProvider>
  );
}
