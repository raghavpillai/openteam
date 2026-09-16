import type { ProductEvent } from "@openteam/contracts";

const listeners = new Set<(botId: string | null) => void>();
const changedBots = new Set<string>();
const changeListeners = new Set<() => void>();

// Keep the indicator while the details pane is unmounted. Reconnects only
// refresh data; they are not evidence that the Bot learned anything new.
export const hasUnseenMemoryChange = (botId: string) => changedBots.has(botId);
export const subscribeMemoryChanges = (listener: () => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};
export const acknowledgeMemoryChanges = (botId: string) => {
  if (!changedBots.delete(botId)) return;
  for (const listener of changeListeners) listener();
};

export const subscribeMemoryRefresh = (listener: (botId: string | null) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const refreshMemoryViews = (event?: ProductEvent) => {
  if (event && event.topic !== "memory.changed" && event.topic !== "snapshot.required") return;
  const botId = event?.topic === "memory.changed" ? event.entityId : null;
  if (botId !== null) {
    changedBots.add(botId);
    for (const listener of changeListeners) listener();
  }
  for (const listener of listeners) listener(botId);
};
