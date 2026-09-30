import type { ComputerEvent } from "@openteam/contracts";
import { parseComputerEvent } from "@openteam/contracts/service-protocol";

/** The computer owns a live turn until its stream completes or is cancelled. */
export async function consumeComputerEvents(
  body: ReadableStream<Uint8Array>,
  apply: (event: ComputerEvent) => Promise<void>,
  abortTransport: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (line.trim()) await apply(parseComputerEvent(JSON.parse(line)));
      }
      if (done) return;
    }
  } catch (error) {
    abortTransport();
    throw error;
  } finally {
    // A failed DB projection must also disconnect the runtime, whose stream
    // cancellation handler aborts the turn. Preserve the original failure if
    // transport cleanup itself fails.
    try { await reader.cancel(); } catch { /* already errored/disconnected */ }
    reader.releaseLock();
  }
}
