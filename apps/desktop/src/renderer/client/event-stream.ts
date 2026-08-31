import type { ProductEvent } from "@openbot/contracts";
import { authHeaders, clearAuthToken } from "./auth";
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
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`${API_BASE}/api/v0/events?after=${encodeURIComponent(after)}`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (response.status === 401) clearAuthToken();
      if (!response.ok || !response.body)
        throw new Error(`Event stream failed (${response.status})`);
      handlers.onOpen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const eventName = block
            .split("\n")
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (eventName === "product" && data) {
            handlers.onEvent(JSON.parse(data) as ProductEvent);
          } else if (eventName === "stream-error") {
            handlers.onError();
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (!controller.signal.aborted) handlers.onError();
    } catch {
      if (!controller.signal.aborted) handlers.onError();
    }
  })();
  return () => controller.abort();
};
