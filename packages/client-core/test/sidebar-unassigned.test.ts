import { expect, test } from "bun:test";
import { sidebarPreferencesFromRootSettings } from "../src/index";

test("imports the reserved Unassigned section without a duplicate heading or assignment", () => {
  const result = sidebarPreferencesFromRootSettings(
    {
      valid: true,
      settings: {
        sidebarSections: [
          { id: "work", name: "Work", agentIds: ["a"], isCollapsed: true },
          { id: "__agents__", name: "Unassigned", agentIds: ["b"], isCollapsed: false },
        ],
      },
    },
    {
      version: 2,
      pinnedIds: [],
      unreadIds: ["b"],
      sections: [],
      sectionByChannel: {},
      channelOrderByGroup: {},
      unassignedCollapsed: true,
    }
  );
  expect(result?.sections).toEqual([{ id: "work", name: "Work", collapsed: true }]);
  expect(result?.sectionByChannel).toEqual({ a: "work" });
  expect(result?.unassignedCollapsed).toBe(false);
  expect(result?.unreadIds).toEqual(["b"]);
});
