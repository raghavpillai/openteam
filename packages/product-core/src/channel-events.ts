import type { ChannelMessageView } from "@openbot/contracts";
import { messageMetadata } from "./messages";

export interface ChannelNameChangedEvent {
  type: "name-changed";
  from: string;
  to: string;
}

export type RoutineChangedAction = "created" | "updated" | "enabled" | "disabled" | "deleted";

export interface RoutineChangedEvent {
  type: "automation-changed";
  action: RoutineChangedAction;
  automationId: string;
  automationName: string;
}

const eventMetadata = (message: ChannelMessageView): Record<string, unknown> | null => {
  const metadata = messageMetadata(message);
  if (metadata.type !== "event") return null;
  const event = metadata.event;
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : null;
};

export const channelNameChangedEventFor = (
  message: ChannelMessageView
): ChannelNameChangedEvent | null => {
  const value = eventMetadata(message);
  return value?.type === "name-changed" &&
    typeof value.from === "string" &&
    typeof value.to === "string"
    ? { type: "name-changed", from: value.from, to: value.to }
    : null;
};

export const routineChangedEventFor = (message: ChannelMessageView): RoutineChangedEvent | null => {
  const value = eventMetadata(message);
  const action = value?.action;
  return value?.type === "automation-changed" &&
    ["created", "updated", "enabled", "disabled", "deleted"].includes(String(action)) &&
    typeof value.automationId === "string" &&
    typeof value.automationName === "string"
    ? {
        type: "automation-changed",
        action: action as RoutineChangedAction,
        automationId: value.automationId,
        automationName: value.automationName,
      }
    : null;
};

export const routineChangedActionLabel = (action: RoutineChangedAction): string =>
  `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} routine`;

export const channelMessageSummary = (message: ChannelMessageView): string => {
  const nameChange = channelNameChangedEventFor(message);
  if (nameChange) return `Renamed to ${nameChange.to}`;
  const routineChange = routineChangedEventFor(message);
  return routineChange
    ? `${routineChangedActionLabel(routineChange.action)} ${routineChange.automationName}`
    : message.content;
};
