import { describe, expect, test } from "bun:test";
import {
  addSidebarUnread,
  removeSidebarUnread,
  toggleSidebarUnread,
} from "@openbot/contracts/client-preferences";
import type { SidebarPreferences } from "../src/renderer/hooks/use-sidebar-preferences";

const preferences = (unreadIds: string[]): SidebarPreferences => ({
  version: 2,
  pinnedIds: [],
  unreadIds,
  unassignedCollapsed: false,
  sections: [],
  sectionByChannel: {},
  channelOrderByGroup: {},
});

describe("batched sidebar unread preferences", () => {
  test("merges a large activity burst in one immutable update", () => {
    const current = preferences(["existing"]);
    const next = addSidebarUnread(
      current,
      Array.from({ length: 1_000 }, (_, index) => `channel-${index}`)
    );

    expect(next).not.toBe(current);
    expect(next.unreadIds).toHaveLength(1_001);
    expect(addSidebarUnread(next, ["channel-4", "existing"])).toBe(next);
  });

  test("removes a burst once and preserves identity when nothing matches", () => {
    const current = preferences(["one", "two", "three"]);
    expect(removeSidebarUnread(current, ["one", "three"]).unreadIds).toEqual(["two"]);
    expect(removeSidebarUnread(current, ["missing"])).toBe(current);
  });

  test("toggles unread state through the shared preference reducer", () => {
    const current = preferences([]);
    const unread = toggleSidebarUnread(current, "one");
    expect(unread.unreadIds).toEqual(["one"]);
    expect(toggleSidebarUnread(unread, "one").unreadIds).toEqual([]);
  });
});
