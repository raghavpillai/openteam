import type { ChannelMessageView } from "@openbot/contracts";

export interface ChannelNameChangedEvent {
  type: "name-changed";
  from: string;
  to: string;
}

export function channelNameChangedEventFor(
  message: ChannelMessageView
): ChannelNameChangedEvent | null {
  if (
    !message.metadata ||
    typeof message.metadata !== "object" ||
    Array.isArray(message.metadata)
  ) {
    return null;
  }
  const metadata = message.metadata as Record<string, unknown>;
  if (metadata.type !== "event") return null;
  const event = metadata.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const value = event as Record<string, unknown>;
  return value.type === "name-changed" &&
    typeof value.from === "string" &&
    typeof value.to === "string"
    ? { type: "name-changed", from: value.from, to: value.to }
    : null;
}

export function channelMessageSummary(message: ChannelMessageView): string {
  const event = channelNameChangedEventFor(message);
  return event ? `Renamed to ${event.to}` : message.content;
}
