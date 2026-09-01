import { describe, expect, test } from "bun:test";
import {
  emptySidebarPreferences,
  normalizeSidebarPreferences,
  parseSidebarPreferences,
  toggleSidebarPinned,
} from "../src/client-preferences";
import {
  parseComputerEvent,
  parseHostMachinesResponse,
  parseHostShellResponse,
} from "../src/service-protocol";

describe("shared boundary codecs", () => {
  test("normalizes legacy sidebar sections", () => {
    expect(
      normalizeSidebarPreferences({
        pinnedIds: ["channel-1"],
        unreadIds: [],
        sectionByChannel: { "channel-1": "Projects" },
      })
    ).toMatchObject({
      version: 2,
      pinnedIds: ["channel-1"],
      sections: [{ id: "legacy-section-0", name: "Projects", collapsed: false }],
      sectionByChannel: { "channel-1": "legacy-section-0" },
    });
  });

  test("strictly validates persisted sidebar preferences", () => {
    expect(parseSidebarPreferences(emptySidebarPreferences())).toEqual(emptySidebarPreferences());
    expect(() => parseSidebarPreferences({ version: 2, pinnedIds: "bad" })).toThrow();
    const pinned = toggleSidebarPinned(emptySidebarPreferences(), "channel-1");
    expect(pinned.pinnedIds).toEqual(["channel-1"]);
    expect(toggleSidebarPinned(pinned, "channel-1").pinnedIds).toEqual([]);
  });

  test("rejects malformed computer events", () => {
    expect(
      parseComputerEvent({
        type: "turn.completed",
        turnId: "turn-1",
        status: "completed",
      })
    ).toMatchObject({ type: "turn.completed", turnId: "turn-1" });
    expect(() => parseComputerEvent({ type: "agent.delta", turnId: "turn-1" })).toThrow();
  });

  test("validates host responses", () => {
    expect(
      parseHostShellResponse({
        shell_id: "shell-1",
        status: "completed",
        exit_code: 0,
        output: "ok",
        output_path: "/tmp/shell-1",
        elapsed_ms: 3,
      }).output
    ).toBe("ok");
    expect(
      parseHostMachinesResponse({
        machines: [{ machineId: "this-computer", label: "Mac", localToolPermission: "ask" }],
      }).machines
    ).toHaveLength(1);
  });
});
