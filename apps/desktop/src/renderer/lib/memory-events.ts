import type { ProductEvent } from "@openteam/contracts";

const listeners = new Set<(botId: string | null) => void>();

export const subscribeMemoryRefresh = (listener: (botId: string | null) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const refreshMemoryViews = (event?: ProductEvent) => {
  if (event && event.topic !== "memory.changed" && event.topic !== "snapshot.required") return;
  const botId = event?.topic === "memory.changed" ? event.entityId : null;
  for (const listener of listeners) listener(botId);
};
