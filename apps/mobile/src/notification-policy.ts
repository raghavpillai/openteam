import { agentNotificationDeliveryPolicy, isAgentNotificationKind } from "@openbot/contracts";

export interface ForegroundNotificationBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

export const channelIdFromNotificationData = (data: unknown): string | null => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as { channelId?: unknown }).channelId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const foregroundNotificationBehavior = (
  notificationChannelId: string | null,
  activeChannelId: string | null,
  kind: unknown
): ForegroundNotificationBehavior => {
  if (kind === "badge-sync") {
    return {
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  }
  const visible = !notificationChannelId || notificationChannelId !== activeChannelId;
  const shouldPlaySound =
    visible &&
    isAgentNotificationKind(kind) &&
    agentNotificationDeliveryPolicy(kind).sound !== null;
  return {
    shouldShowBanner: visible,
    shouldShowList: visible,
    shouldPlaySound,
    shouldSetBadge: visible,
  };
};
