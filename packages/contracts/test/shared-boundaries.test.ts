import { describe, expect, test } from "bun:test";
import {
  emptySidebarPreferences,
  parseSidebarPreferences,
  toggleSidebarPinned,
} from "../src/client-preferences";

describe("shared boundary codecs", () => {
  test("strictly validates persisted sidebar preferences", () => {
    expect(parseSidebarPreferences(emptySidebarPreferences())).toEqual(emptySidebarPreferences());
    expect(() => parseSidebarPreferences({ version: 2, pinnedIds: "bad" })).toThrow();
    const pinned = toggleSidebarPinned(emptySidebarPreferences(), "channel-1");
    expect(pinned.pinnedIds).toEqual(["channel-1"]);
    expect(toggleSidebarPinned(pinned, "channel-1").pinnedIds).toEqual([]);
  });

});
