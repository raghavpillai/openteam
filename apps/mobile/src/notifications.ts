import type { OpenTeamClient } from "@openteam/client-core/client";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  notificationIsRead,
  type ChannelNotificationView,
  type NotificationReadState,
} from "@openteam/contracts/notification-content";
import { reconcileNotificationReads } from "@openteam/mobile-native";
import {
  channelIdFromNotificationData,
  foregroundNotificationBehavior,
} from "./notification-policy";

const INSTALLATION_KEY = "openteam.push-installation-id";
let activeChannelId: string | null = null;
let installationIdInFlight: Promise<string> | null = null;
const readStates = new Map<string, NotificationReadState>();
const pendingReadStates = new Map<string, NotificationReadState>();
let readSync: Promise<void> | null = null;

export const synchronizeNotificationReads = async (
  states: NotificationReadState[]
): Promise<void> => {
  for (const state of states) {
    if (
      ![state.lastReadSequence, state.lastReadNotificationSequence].every((value) =>
        /^\d+$/.test(value)
      )
    )
      continue;
    const previous = readStates.get(state.channelId);
    const next = {
      channelId: state.channelId,
      lastReadSequence:
        (BigInt(state.lastReadSequence) > BigInt(previous?.lastReadSequence ?? "0")
          ? state.lastReadSequence
          : previous?.lastReadSequence) ?? "0",
      lastReadNotificationSequence:
        (BigInt(state.lastReadNotificationSequence) >
        BigInt(previous?.lastReadNotificationSequence ?? "0")
          ? state.lastReadNotificationSequence
          : previous?.lastReadNotificationSequence) ?? "0",
    };
    if (
      previous &&
      previous.lastReadSequence === next.lastReadSequence &&
      previous.lastReadNotificationSequence === next.lastReadNotificationSequence
    )
      continue;
    readStates.set(state.channelId, next);
    pendingReadStates.set(state.channelId, next);
  }
  if (readSync) return readSync;
  if (!pendingReadStates.size) return;
  readSync = Promise.resolve()
    .then(async () => {
      while (pendingReadStates.size) {
        const changed = [...pendingReadStates.values()];
        await reconcileNotificationReads(changed);
        const presented = await Notifications.getPresentedNotificationsAsync();
        await Promise.all(
          presented.map((notification) => {
            const data = notification.request.content.data as unknown as ChannelNotificationView;
            const state = readStates.get(data.channelId);
            return state && notificationIsRead(data, state)
              ? Notifications.dismissNotificationAsync(notification.request.identifier)
              : Promise.resolve();
          })
        );
        for (const state of changed) {
          if (pendingReadStates.get(state.channelId) === state)
            pendingReadStates.delete(state.channelId);
        }
      }
    })
    .finally(() => {
      readSync = null;
    });
  return readSync;
};
type PushOperationGuard = () => boolean;
type PushOperationObserver = (operation: Promise<void>) => void;

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
    const data = notification.request.content.data;
    if (data?.kind === "badge-sync" && data.readState) {
      void synchronizeNotificationReads([data.readState as NotificationReadState]).catch(
        () => undefined
      );
    }
    const state = readStates.get(notificationChannelId(notification) ?? "");
    if (state && notificationIsRead(data as unknown as ChannelNotificationView, state)) {
      return foregroundNotificationBehavior(null, null, "badge-sync");
    }
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
  if (installationIdInFlight) return installationIdInFlight;
  const request = (async () => {
    const current = await SecureStore.getItemAsync(INSTALLATION_KEY);
    if (current) return current;
    const generated =
      globalThis.crypto?.randomUUID?.() ??
      `openteam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await SecureStore.setItemAsync(INSTALLATION_KEY, generated);
    return generated;
  })();
  installationIdInFlight = request;
  void request.then(
    () => {
      if (installationIdInFlight === request) installationIdInFlight = null;
    },
    () => {
      if (installationIdInFlight === request) installationIdInFlight = null;
    }
  );
  return request;
};

const registerToken = async (
  client: OpenTeamClient,
  operationCurrent?: PushOperationGuard
): Promise<void> => {
  const configuredProjectId = projectId();
  if (!configuredProjectId) {
    throw new Error("Push notifications need EXPO_PUBLIC_EXPO_PROJECT_ID or an EAS project ID.");
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId: configuredProjectId });
  if (operationCurrent && !operationCurrent()) return;
  const currentInstallationId = await installationId();
  if (operationCurrent && !operationCurrent()) return;
  await client.registerPushDevice({
    installationId: currentInstallationId,
    platform: Platform.OS === "android" ? "android" : "ios",
    pushToken: token.data,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  });
};

export const unregisterPushInstallation = async (
  client: OpenTeamClient,
  operationCurrent?: PushOperationGuard
): Promise<void> => {
  const currentInstallationId = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (operationCurrent && !operationCurrent()) return;
  if (currentInstallationId) await client.unregisterPushDevice(currentInstallationId);
};

export const synchronizePushRegistration = async (
  client: OpenTeamClient,
  requestPermission: boolean,
  operationCurrent?: PushOperationGuard
): Promise<NotificationPermissionState> => {
  let permissions = await Notifications.getPermissionsAsync();
  if (!authorized(permissions) && requestPermission && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
  }
  if (operationCurrent && !operationCurrent()) return "unavailable";
  if (!authorized(permissions)) {
    await unregisterPushInstallation(client, operationCurrent).catch(() => undefined);
    return permissions.canAskAgain ? "not_determined" : "denied";
  }
  await registerToken(client, operationCurrent);
  return "granted";
};

export const listenForPushTokenChanges = (
  client: OpenTeamClient,
  onError: (error: unknown) => void,
  operationCurrent?: PushOperationGuard,
  onOperation?: PushOperationObserver
) =>
  Notifications.addPushTokenListener(() => {
    const operation = registerToken(client, operationCurrent);
    onOperation?.(operation);
    void operation.catch(onError);
  });

export const clearNotificationBadge = (): Promise<boolean> => Notifications.setBadgeCountAsync(0);
export const setNotificationBadge = (count: number): Promise<boolean> =>
  Notifications.setBadgeCountAsync(Math.max(0, Math.floor(count)));

export { Notifications };
