import { describe, expect, test } from "bun:test";
import { AgentMessaging, TRANSCRIPT_PROJECTION_DEBOUNCE_SECONDS } from "../src";

describe("transcript projection scheduling", () => {
  test("deduplicates bot ids and uses a keyed trailing debounce", async () => {
    const calls: unknown[][] = [];
    const messaging = Object.create(AgentMessaging.prototype) as AgentMessaging;
    Object.defineProperty(messaging, "boss", {
      value: {
        sendDebounced: async (...args: unknown[]) => {
          calls.push(args);
          return "job";
        },
      },
    });

    await messaging.scheduleTranscriptProjection({} as never, ["bot-1", "bot-1", "bot-2"]);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call[4])).toEqual(["bot-1", "bot-2"]);
    expect(calls.every((call) => call[3] === TRANSCRIPT_PROJECTION_DEBOUNCE_SECONDS)).toBe(true);
  });
});
