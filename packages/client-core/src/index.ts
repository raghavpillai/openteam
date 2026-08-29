export * from "./client";
export * from "./http";
export * from "./snapshot";

import type { ProductEvent } from "@openbot/contracts";

export const shouldRefreshForEvent = (event: ProductEvent): boolean => {
  if (event.topic === "message.delta" || event.topic === "conversation.attached") return false;
  if (event.topic === "run_item.started" || event.topic === "run_item.completed") {
    const item = (event.payload as { item?: { type?: string } } | null)?.item;
    return !item?.type || !["agentMessage", "reasoning", "plan"].includes(item.type);
  }
  return true;
};
