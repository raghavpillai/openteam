export { deriveA2AExchange } from "@openbot/product-core/messages";

export type A2AExchangePhase = "entering" | "open" | "exiting";

export interface A2AExchangeState {
  sourceChannelId: string;
  sourceBotId: string;
  peerId: string;
  phase: A2AExchangePhase;
}

export const startA2AExchange = (
  sourceChannelId: string,
  sourceBotId: string,
  peerId: string
): A2AExchangeState => ({
  sourceChannelId,
  sourceBotId,
  peerId,
  phase: "entering",
});

export const closeA2AExchange = (state: A2AExchangeState): A2AExchangeState =>
  state.phase === "exiting" ? state : { ...state, phase: "exiting" };

export const finishA2AExchangeAnimation = (state: A2AExchangeState): A2AExchangeState | null => {
  if (state.phase === "entering") return { ...state, phase: "open" };
  if (state.phase === "exiting") return null;
  return state;
};
