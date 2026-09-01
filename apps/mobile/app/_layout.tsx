import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppearanceProvider, useAppearance } from "../src/appearance";
import { AuthGate } from "../src/components/auth-gate";
import { channelIdFromNotificationResponse, Notifications } from "../src/notifications";
import { OpenBotProvider } from "../src/state/openbot-context";
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

function RootNavigation() {
  const { dark } = useAppearance();
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style={dark ? "light" : "dark"} />
          <AuthGate>
            <OpenBotProvider>
              <NotificationNavigation />
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
                <Stack.Screen name="details/[channelId]" options={{ headerShown: false }} />
                <Stack.Screen
                  name="routine/[channelId]/[routineId]"
                  options={{ headerShown: false }}
                />
                <Stack.Screen name="computer/[botId]" options={{ headerShown: false }} />
                <Stack.Screen
                  name="search"
                  options={{ headerShown: false, presentation: "modal" }}
                />
                <Stack.Screen name="new" options={{ headerShown: false, presentation: "modal" }} />
                <Stack.Screen
                  name="settings"
                  options={{ headerShown: false, presentation: "pageSheet" }}
                />
              </Stack>
            </OpenBotProvider>
          </AuthGate>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <AppearanceProvider>
      <RootNavigation />
    </AppearanceProvider>
  );
}
