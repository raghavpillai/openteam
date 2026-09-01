import type { ProductEvent } from "@openbot/contracts";
import { parseProductEvent } from "@openbot/contracts/event-protocol";
import { OpenBotClientError } from "./http";

export interface ProductEventHandlers {
  onEvent: (event: ProductEvent) => void;
  onOpen?: () => void;
  onStreamError?: (message: string) => void;
}

const eventBlock = (block: string, handlers: ProductEventHandlers): void => {
  let eventName = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  const payload = data.join("\n");
  if (eventName === "stream-error") {
    let message = "The live event stream reported an error";
    try {
      const parsed = JSON.parse(payload) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // Preserve the stable fallback message for a malformed diagnostic event.
    }
    handlers.onStreamError?.(message);
    return;
  }
  if (eventName !== "product") return;
  let parsed: ProductEvent;
  try {
    parsed = parseProductEvent(JSON.parse(payload));
  } catch {
    throw new OpenBotClientError("OpenBot returned an invalid live event", "invalid_event");
  }
  handlers.onEvent(parsed);
};

/** Consume a fetch-backed SSE body without buffering the lifetime of the stream. */
export const consumeProductEventStream = async (
  response: Response,
  handlers: ProductEventHandlers,
  signal?: AbortSignal
): Promise<void> => {
  if (!response.ok || !response.body) {
    throw new OpenBotClientError(
      `Event stream failed (${response.status})`,
      "event_stream_failed",
      response.status
    );
  }
  handlers.onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        eventBlock(buffer.slice(0, boundary), handlers);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        if (buffer.trim()) eventBlock(buffer, handlers);
        completed = true;
        break;
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
