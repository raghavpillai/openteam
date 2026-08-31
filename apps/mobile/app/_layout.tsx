import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { channelIdFromNotificationResponse, Notifications } from "../src/notifications";
import { OpenBotProvider } from "../src/state/openbot-context";
import { AuthGate } from "../src/components/auth-gate";
import { darkTheme, lightTheme } from "../src/theme";

function NotificationNavigation() {
  useEffect(() => {
    const openResponse = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const channelId = channelIdFromNotificationResponse(response);
      if (!channelId) return;
      router.push({ pathname: "/chat/[channelId]", params: { channelId } });
      Notifications.clearLastNotificationResponse();
    };
    openResponse(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(openResponse);
    return () => subscription.remove();
  }, []);
  return null;
}

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
      <ThemeProvider value={navigationTheme}>
        <AuthGate>
          <OpenBotProvider>
            <NotificationNavigation />
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
              <Stack.Screen name="settings" options={{ headerShown: false }} />
            </Stack>
          </OpenBotProvider>
        </AuthGate>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
