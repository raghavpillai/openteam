import { expect, test } from "bun:test";
import {
  acknowledgeMemoryChanges,
  hasUnseenMemoryChange,
  refreshMemoryViews,
  subscribeMemoryChanges,
  subscribeMemoryRefresh,
} from "../src/renderer/lib/memory-events";

test("memory changes survive a closed pane, stay bot-scoped, and clear only when viewed", () => {
  const event = (entityId: string) => ({
    sequence: "1",
    topic: "memory.changed",
    entityId,
    payload: { botId: entityId },
    createdAt: new Date().toISOString(),
  });
  refreshMemoryViews(event("indicator-a"));
  refreshMemoryViews(event("indicator-b"));
  expect(hasUnseenMemoryChange("indicator-a")).toBe(true);
  expect(hasUnseenMemoryChange("indicator-b")).toBe(true);
  let notices = 0,
    reads = 0;
  const stopNotices = subscribeMemoryChanges(() => notices++);
  const stopReads = subscribeMemoryRefresh(() => reads++);
  acknowledgeMemoryChanges("indicator-a");
  expect(hasUnseenMemoryChange("indicator-a")).toBe(false);
  expect(hasUnseenMemoryChange("indicator-b")).toBe(true);
  expect(notices).toBe(1);
  expect(reads).toBe(0);
  refreshMemoryViews();
  refreshMemoryViews({ ...event("indicator-a"), topic: "snapshot.required" });
  expect(hasUnseenMemoryChange("indicator-a")).toBe(false);
  expect(reads).toBe(2);
  stopNotices();
  stopReads();
  acknowledgeMemoryChanges("indicator-b");
});
