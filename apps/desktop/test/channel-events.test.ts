import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import {
  channelMessageSummary,
  channelNameChangedEventFor,
  routineChangedEventFor,
  turnInterruptedEventFor,
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

  test("shows a restart notice as its own text, only for system messages", () => {
    const notice = "This reply was interrupted by a restart. Send your message again to continue.";
    const value = {
      ...message({ type: "event", event: { type: "turn-interrupted", reason: "restart", runId: "run-1" } }),
      content: notice,
    };

    expect(turnInterruptedEventFor(value)).toEqual({ type: "turn-interrupted", reason: "restart" });
    expect(channelMessageSummary(value)).toBe(notice);
    expect(turnInterruptedEventFor({ ...value, sender: "agent" })).toBeNull();
    expect(turnInterruptedEventFor(message({ type: "event", event: { type: "name-changed" } }))).toBeNull();
  });
});
