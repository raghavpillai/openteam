import type { ProductEvent } from "@openbot/contracts";
import { API_BASE } from "./http";

export const shouldRefreshForEvent = (event: ProductEvent) => {
  if (event.topic === "message.delta" || event.topic === "conversation.attached") return false;
  if (event.topic === "run_item.started" || event.topic === "run_item.completed") {
    const item = (event.payload as { item?: { type?: string } } | null)?.item;
    return !item?.type || !["agentMessage", "reasoning", "plan"].includes(item.type);
  }
  return true;
};

export const subscribeToProductEvents = (
  after: string,
  handlers: {
    onEvent: (event: ProductEvent) => void;
    onOpen: () => void;
    onError: () => void;
  }
) => {
  const source = new EventSource(`${API_BASE}/api/v0/events?after=${encodeURIComponent(after)}`);
  source.addEventListener("product", (event) => {
    try {
      handlers.onEvent(JSON.parse((event as MessageEvent).data) as ProductEvent);
    } catch {
      handlers.onError();
    }
  });
  source.addEventListener("stream-error", handlers.onError);
  source.onopen = handlers.onOpen;
  return () => source.close();
};
