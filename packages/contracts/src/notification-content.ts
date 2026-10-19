/** Cross-process PostgreSQL advisory lock protecting the final push authorization/send boundary. */
export const PUSH_DELIVERY_ADVISORY_LOCK = {
  namespace: 0x4f50424f,
  key: 0x54505553,
} as const;

export const normalizeNotificationText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

type GraphemeSegmenter = { segment: (input: string) => Iterable<{ segment: string }> };
type GraphemeSegmenterConstructor = new (
  locale?: string,
  options?: { granularity: "grapheme" }
) => GraphemeSegmenter;
let cachedSegmenterConstructor: GraphemeSegmenterConstructor | undefined;
let cachedSegmenter: GraphemeSegmenter | undefined;
const notificationSegmenter = (): GraphemeSegmenter | undefined => {
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
  if (Segmenter !== cachedSegmenterConstructor) {
    cachedSegmenterConstructor = Segmenter;
    cachedSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  }
  return cachedSegmenter;
};

export const notificationGraphemes = (value: string): string[] => {
  const normalized = normalizeNotificationText(value);
  const segmenter = notificationSegmenter();
  return segmenter
    ? [...segmenter.segment(normalized)].map((part) => part.segment)
    : Array.from(normalized);
};

export const truncateNotificationText = (value: string, limit = 140): string => {
  const normalized = normalizeNotificationText(value);
  if (normalized.length <= limit) return normalized;
  if (Number.isNaN(limit) || limit < 0) return "…";
  const prefixLength = Math.max(0, Math.trunc(limit - 1));
  // Whitespace normalization removes CRLF clusters; ASCII then has one code
  // unit per grapheme. Unicode still takes the exact grapheme-aware path.
  if (/^[\x00-\x7f]*$/.test(normalized)) return `${normalized.slice(0, prefixLength)}…`;
  const segments = notificationSegmenter()?.segment(normalized) ?? normalized;
  let count = 0;
  let prefix = "";
  for (const part of segments) {
    count += 1;
    if (count > limit) return `${prefix}…`;
    if (count <= prefixLength) prefix += typeof part === "string" ? part : part.segment;
  }
  return normalized;
};

/** Every visible Bot message, cards included, is a `message`. */
export type AgentNotificationKind = "message" | "reaction";

export interface NotificationReadState {
  channelId: string;
  lastReadSequence: string;
  lastReadNotificationSequence: string;
}

export interface ChannelNotificationView {
  notificationSequence: string;
  channelId: string;
  botId: string;
  kind: AgentNotificationKind;
  messageSequence: string;
  /** Set when the message is a reply inside a thread, so opening the alert opens that thread. */
  threadMessageId?: string;
  title: string;
  body: string;
  sender?: NotificationSender;
}

/** Self-contained identity: extensions can draw the avatar without a network request. */
export interface NotificationSender {
  name: string;
  icon: string;
  color: string;
  /** Desktop renderer-local PNG, never required in a push payload. */
  avatarDataUrl?: string;
}

export interface ChannelNotificationState extends NotificationReadState {
  notificationCursor: string;
  notifications: ChannelNotificationView[];
  activityUnreadCount: number;
}

export const notificationIsRead = (
  notification: Pick<ChannelNotificationView, "kind" | "messageSequence" | "notificationSequence">,
  state: Pick<NotificationReadState, "lastReadSequence" | "lastReadNotificationSequence">
): boolean => {
  const sequence = (value: string | undefined) =>
    value && /^\d+$/.test(value) ? BigInt(value) : -1n;
  if (notification.kind === "reaction") {
    return (
      sequence(notification.notificationSequence) >= 0n &&
      sequence(notification.notificationSequence) <= sequence(state.lastReadNotificationSequence)
    );
  }
  return (
    sequence(notification.messageSequence) >= 0n &&
    sequence(notification.messageSequence) <= sequence(state.lastReadSequence)
  );
};

export interface AgentNotificationPresentation {
  title: string;
  body: string;
  sound: "default";
}

/** Shared presentation contract for native macOS and iOS notifications. */
const agentNotificationTypeCatalog = {
  message: { fallbackBody: "Open OpenTeam to see what it did.", sound: "default" },
  reaction: { fallbackBody: "Reacted to your message.", sound: "default" },
} as const satisfies Record<AgentNotificationKind, { fallbackBody: string; sound: "default" }>;

export const isAgentNotificationKind = (value: unknown): value is AgentNotificationKind =>
  typeof value === "string" && Object.hasOwn(agentNotificationTypeCatalog, value);

export const agentNotificationDeliveryPolicy = (
  kind: AgentNotificationKind
): Pick<AgentNotificationPresentation, "sound"> => ({
  sound: agentNotificationTypeCatalog[kind].sound,
});

export const agentNotificationPresentation = (input: {
  kind: AgentNotificationKind;
  botName: string;
  body?: string | null;
}): AgentNotificationPresentation => {
  const definition = agentNotificationTypeCatalog[input.kind];
  return {
    title: normalizeNotificationText(input.botName) || "OpenTeam",
    body: truncateNotificationText(input.body?.trim() ? input.body : definition.fallbackBody),
    ...agentNotificationDeliveryPolicy(input.kind),
  };
};
