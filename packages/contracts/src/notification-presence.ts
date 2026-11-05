/** Device availability is a lease, separate from the five-minute Mac idle limit. */
export const NOTIFICATION_PRESENCE_TTL_MS = 60_000;
export const NOTIFICATION_HEARTBEAT_MS = 30_000;
export const MAC_NOTIFICATION_IDLE_SECONDS = 300;

export interface NotificationPresenceInput {
  /** A new ID for each client lifecycle; sequence orders overlapping requests. */
  clientId: string;
  sequence: number;
  platform: "macos" | "ios";
  active: boolean;
  idleSeconds?: number;
}

export interface NotificationRouting {
  smartEnabled: boolean;
  serverTime: number;
  iosActiveUntil: number;
  macActiveUntil: number;
}

export function notificationPresenceLifetime(input: NotificationPresenceInput): number {
  if (!input.active) return 0;
  if (input.platform === "ios") return NOTIFICATION_PRESENCE_TTL_MS;
  return Math.max(
    0,
    Math.min(
      NOTIFICATION_PRESENCE_TTL_MS,
      (MAC_NOTIFICATION_IDLE_SECONDS - (input.idleSeconds ?? MAC_NOTIFICATION_IDLE_SECONDS)) * 1_000
    )
  );
}

export function suppressMobileNotification(
  routing: NotificationRouting,
  now = routing.serverTime
): boolean {
  return routing.smartEnabled && routing.iosActiveUntil <= now && routing.macActiveUntil > now;
}
