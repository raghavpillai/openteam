import type { ChannelMessageView } from "@openbot/contracts";

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
  if (!message.metadata || typeof message.metadata !== "object" || Array.isArray(message.metadata)) {
    return null;
  }
  const metadata = message.metadata as Record<string, unknown>;
  if (metadata.type !== "event") return null;
  const event = metadata.event;
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : null;
};

export function channelNameChangedEventFor(
  message: ChannelMessageView
): ChannelNameChangedEvent | null {
  const value = eventMetadata(message);
  if (!value) return null;
  return value.type === "name-changed" &&
    typeof value.from === "string" &&
    typeof value.to === "string"
    ? { type: "name-changed", from: value.from, to: value.to }
    : null;
}

export function routineChangedEventFor(message: ChannelMessageView): RoutineChangedEvent | null {
  const value = eventMetadata(message);
  if (!value) return null;
  const action = value.action;
  return value.type === "automation-changed" &&
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
}

export const routineChangedActionLabel = (action: RoutineChangedAction): string =>
  `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} routine`;

export function channelMessageSummary(message: ChannelMessageView): string {
  const event = channelNameChangedEventFor(message);
  if (event) return `Renamed to ${event.to}`;
  const routine = routineChangedEventFor(message);
  return routine
    ? `${routineChangedActionLabel(routine.action)} ${routine.automationName}`
    : message.content;
}
