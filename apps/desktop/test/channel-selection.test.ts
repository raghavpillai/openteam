import { describe, expect, test } from "bun:test";
import type { ChannelView } from "@openteam/contracts";
import {
  activeAgentIdForChannel,
  restoredActiveChannelId,
} from "../src/renderer/lib/channel-selection";

const channel = (id: string, directKey: string): ChannelView =>
  ({
    id,
    kind: "bot_dm",
    name: id,
    description: "",
    directKey,
    workingDirectory: null,
    members: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  }) as ChannelView;

describe("active-agent selection restore", () => {
  const channels = [channel("saved-home", "bot:saved"), channel("clicked-home", "bot:clicked")];

  test("restores the saved active agent when selection stayed untouched", () => {
    expect(
      restoredActiveChannelId({
        activeAgentId: "saved",
        channels,
        currentSelectedId: "clicked-home",
        selectionRevisionAtRequest: 0,
        currentSelectionRevision: 0,
      })
    ).toBe("saved-home");
  });

  test("does not let a late restore steal a newer user selection", () => {
    expect(
      restoredActiveChannelId({
        activeAgentId: "saved",
        channels,
        currentSelectedId: "clicked-home",
        selectionRevisionAtRequest: 0,
        currentSelectionRevision: 1,
      })
    ).toBe("clicked-home");
  });

  test("keeps the current selection when the saved agent is unavailable", () => {
    expect(
      restoredActiveChannelId({
        activeAgentId: "archived",
        channels,
        currentSelectedId: "clicked-home",
        selectionRevisionAtRequest: 0,
        currentSelectionRevision: 0,
      })
    ).toBe("clicked-home");
  });

  test("stores and restores a group namespace as the active session", () => {
    const group = { ...channel("room-1", ""), kind: "group", directKey: null } as ChannelView;
    expect(activeAgentIdForChannel(group)).toBe("room-1");
    expect(
      restoredActiveChannelId({
        activeAgentId: "room-1",
        channels: [...channels, group],
        currentSelectedId: "clicked-home",
        selectionRevisionAtRequest: 0,
        currentSelectionRevision: 0,
      })
    ).toBe("room-1");
  });
});
