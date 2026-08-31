import type { OpenBotClient } from "@openbot/client-core";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  channelIdFromNotificationData,
  foregroundNotificationBehavior,
} from "./notification-policy";

const INSTALLATION_KEY = "openbot.push-installation-id";
let activeChannelId: string | null = null;

export type NotificationPermissionState =
  | "loading"
  | "not_determined"
  | "granted"
  | "denied"
  | "unavailable";

const notificationChannelId = (notification: Notifications.Notification): string | null => {
  return channelIdFromNotificationData(notification.request.content.data);
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    return foregroundNotificationBehavior(
      notificationChannelId(notification),
      activeChannelId,
      notification.request.content.data?.kind
    );
  },
});

export const setActiveNotificationChannel = (channelId: string | null): void => {
  activeChannelId = channelId;
};

export const channelIdFromNotificationResponse = (
  response: Notifications.NotificationResponse
): string | null => notificationChannelId(response.notification);

const authorized = (permissions: Notifications.NotificationPermissionsStatus): boolean =>
  permissions.granted ||
  permissions.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
  permissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
  permissions.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;

export const notificationPermissionState = async (): Promise<NotificationPermissionState> => {
  if (!Notifications.getPermissionsAsync) return "unavailable";
  const permissions = await Notifications.getPermissionsAsync();
  if (authorized(permissions)) return "granted";
  return permissions.canAskAgain ? "not_determined" : "denied";
};

const projectId = (): string | null =>
  process.env.EXPO_PUBLIC_EXPO_PROJECT_ID?.trim() ||
  Constants.expoConfig?.extra?.eas?.projectId ||
  Constants.easConfig?.projectId ||
  null;

const installationId = async (): Promise<string> => {
  const current = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (current) return current;
  const generated =
    globalThis.crypto?.randomUUID?.() ??
    `openbot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await SecureStore.setItemAsync(INSTALLATION_KEY, generated);
  return generated;
};

const registerToken = async (client: OpenBotClient): Promise<void> => {
  const configuredProjectId = projectId();
  if (!configuredProjectId) {
    throw new Error("Push notifications need EXPO_PUBLIC_EXPO_PROJECT_ID or an EAS project ID.");
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId: configuredProjectId });
  await client.registerPushDevice({
    installationId: await installationId(),
    platform: Platform.OS === "android" ? "android" : "ios",
    pushToken: token.data,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  });
};

export const synchronizePushRegistration = async (
  client: OpenBotClient,
  requestPermission: boolean
): Promise<NotificationPermissionState> => {
  let permissions = await Notifications.getPermissionsAsync();
  if (!authorized(permissions) && requestPermission && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
  }
  if (!authorized(permissions)) {
    const currentInstallationId = await SecureStore.getItemAsync(INSTALLATION_KEY);
    if (currentInstallationId) {
      await client.unregisterPushDevice(currentInstallationId).catch(() => undefined);
    }
    return permissions.canAskAgain ? "not_determined" : "denied";
  }
  await registerToken(client);
  return "granted";
};

export const listenForPushTokenChanges = (
  client: OpenBotClient,
  onError: (error: unknown) => void
) =>
  Notifications.addPushTokenListener(() => {
    void registerToken(client).catch(onError);
  });

export const clearNotificationBadge = (): Promise<boolean> => Notifications.setBadgeCountAsync(0);
export const setNotificationBadge = (count: number): Promise<boolean> =>
  Notifications.setBadgeCountAsync(Math.max(0, Math.floor(count)));

export { Notifications };
