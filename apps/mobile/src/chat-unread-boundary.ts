import type { ChannelMessageView } from "@openteam/contracts";
import { messageMetadata } from "@openteam/product-core/messages";

type Message = Pick<ChannelMessageView, "id" | "sequence" | "sender" | "metadata">;
const sequence = (value: string) => (/^\d+$/.test(value) ? BigInt(value) : 0n);
const countsAsUnread = (message: Message) => {
  const metadata = messageMetadata(message as ChannelMessageView);
  return message.sender === "agent" && !("fromAgent" in metadata) && !("toAgent" in metadata);
};

/** Older snapshots contain only message unread counts; newer ones also include activity. */
export function unreadChatMessageCount(channel?: {
  unreadCount?: number;
  notificationState?: { activityUnreadCount: number };
}) {
  return Math.max(
    0,
    (channel?.unreadCount ?? 0) - (channel?.notificationState?.activityUnreadCount ?? 0)
  );
}

/** A reading-session boundary survives read receipts, sends, and history pagination. */
export class ChatUnreadBoundary {
  private initialized = false;
  private openingLatest = 0n;
  private latest = 0n;
  private boundary: string | null = null;
  private readonly openingUnread: number;

  constructor(unreadCount: number) {
    this.openingUnread = Number.isFinite(unreadCount) ? Math.max(0, Math.floor(unreadCount)) : 0;
  }

  observe(messages: readonly Message[], ready: boolean, hasNewer = false): string | null {
    if (!ready || hasNewer) return this.boundary;
    const ordered = [...messages]
      .filter((message) => sequence(message.sequence) > 0n)
      .sort((a, b) => (sequence(a.sequence) < sequence(b.sequence) ? -1 : 1));
    const newest = sequence(ordered.at(-1)?.sequence ?? "0");
    if (!this.initialized) {
      this.initialized = true;
      this.openingLatest = newest;
      this.latest = newest;
    }
    if (!this.boundary && this.openingUnread > 0) {
      const openingMessages = ordered.filter(
        (message) => sequence(message.sequence) <= this.openingLatest && countsAsUnread(message)
      );
      // The real boundary may still be in an unloaded older page.
      if (openingMessages.length >= this.openingUnread)
        this.boundary =
          openingMessages[openingMessages.length - this.openingUnread]?.sequence ?? null;
    } else if (!this.boundary) {
      this.boundary =
        ordered.find(
          (message) => sequence(message.sequence) > this.latest && countsAsUnread(message)
        )?.sequence ?? null;
    }
    if (newest > this.latest) this.latest = newest;
    return this.boundary;
  }
}

export function crossesUnreadBoundary(
  previous: string | undefined,
  current: string,
  boundary: string | null
) {
  return (
    boundary !== null &&
    sequence(current) >= sequence(boundary) &&
    (previous === undefined
      ? sequence(current) === sequence(boundary)
      : sequence(previous) < sequence(boundary))
  );
}
