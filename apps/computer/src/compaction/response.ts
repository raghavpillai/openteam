import { botSummaryText } from "./messages";
import type { BotMessage, BotSummaryResult, BotSummaryUsage } from "./types";

/** A completed response can report usage without containing an assistant. */
export class BotNoSummaryResponseError extends Error {
  constructor(readonly usage?: BotSummaryUsage) {
    super("No assistant response received");
    this.name = "NoSummaryResponseError";
  }
}

/** Decode a completed envelope after the transport has classified failures. */
export const botSummaryResponse = (response: {
  messages: readonly BotMessage[];
  usage?: BotSummaryUsage;
  error?: unknown;
}): BotSummaryResult => {
  // Grok's stream consumer rejects a provider error before accounting usage.
  if (response.error) throw response.error;
  const assistant = response.messages.at(-1);
  if (assistant?.role !== "assistant") throw new BotNoSummaryResponseError(response.usage);
  return { text: botSummaryText(assistant.content), usage: response.usage };
};
