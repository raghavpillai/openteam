import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { END_TURN_HOLD_REMINDER } from "./prompt-context";
import type { ActiveTurn } from "./types";

/** Times one turn may stay open after a closing reply whose sibling call failed, as in the reference. */
export const END_TURN_HOLD_LIMIT = 2;

/**
 * The reference's end-turn hold. Once every call of the closing response has settled, a failed
 * sibling keeps the turn open and the reminder is appended to the closing call's own result.
 * A turn that asked the user something waits for them instead.
 */
export function endTurnHoldExtension(active: ActiveTurn): {
  name: string;
  hidden: boolean;
  factory: ExtensionFactory;
} {
  return {
    name: "openteam-end-turn-hold",
    hidden: true,
    factory(pi) {
      const closingResults = new Set<string>();
      pi.on("tool_result", async (event) => {
        if (!active.endTurnCallId || event.toolCallId !== active.endTurnCallId) return undefined;
        // Pi emits tool_execution_end after this hook returns. An earlier closing
        // result may already be waiting for us, so waiting on it would form a cycle.
        const earlierClosings = new Set(closingResults);
        closingResults.add(event.toolCallId);
        try {
          await Promise.all([...(active.responseCallEnds ?? [])].flatMap(([id, call]) =>
            id === event.toolCallId || earlierClosings.has(id) ? [] : [call.ended]));
        } finally {
          closingResults.delete(event.toolCallId);
        }
        // A later closing sibling owns the reminder after it has settled the batch.
        if (event.toolCallId !== active.endTurnCallId) return undefined;
        const failed = (active.failedResponseCalls ?? []).filter((id) => id !== event.toolCallId);
        if (!active.endTurnRequested || !active.finishResponseCalls || active.awaitingUser || !failed.length ||
            (active.endTurnHolds ?? 0) >= END_TURN_HOLD_LIMIT || active.pluginAbortController?.signal.aborted)
          return undefined;
        active.endTurnHolds = (active.endTurnHolds ?? 0) + 1;
        active.endTurnRequested = false;
        active.finishResponseCalls = false;
        active.endTurnCallId = undefined;
        const details = (event.details ?? {}) as { systemReminders?: string[] };
        return { details: { ...details, systemReminders: [...(details.systemReminders ?? []), END_TURN_HOLD_REMINDER] } };
      });
    },
  };
}
