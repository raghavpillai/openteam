import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import {
  channelMessageSummary,
  channelNameChangedEventFor,
  routineChangedEventFor,
} from "../src/renderer/lib/channel-events";

const message = (metadata: unknown): ChannelMessageView => ({
  id: "event-1",
  sequence: "1",
  channelId: "channel-1",
  sender: "system",
  senderBotId: null,
  sourceRunId: null,
  content: "",
  metadata,
  createdAt: "2026-08-27T18:12:00.000Z",
});

describe("channel timeline events", () => {
  test("projects a structured name change into the exact visible label", () => {
    const value = message({
      type: "event",
      event: { type: "name-changed", from: "New Bot", to: "a2a" },
    });

    expect(channelNameChangedEventFor(value)).toEqual({
      type: "name-changed",
      from: "New Bot",
      to: "a2a",
    });
    expect(channelMessageSummary(value)).toBe("Renamed to a2a");
  });

  test("does not treat arbitrary system metadata as a rename", () => {
    expect(channelNameChangedEventFor(message({ type: "status" }))).toBeNull();
  });

  test("projects durable OpenTeam-compatible routine lifecycle events", () => {
    const value = message({
      type: "event",
      event: {
        type: "automation-changed",
        action: "disabled",
        automationId: "routine-1",
        automationName: "Daily digest",
      },
    });

    expect(routineChangedEventFor(value)).toEqual({
      type: "automation-changed",
      action: "disabled",
      automationId: "routine-1",
      automationName: "Daily digest",
    });
    expect(channelMessageSummary(value)).toBe("Disabled routine Daily digest");
  });
});
