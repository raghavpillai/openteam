import { expect, test } from "bun:test";
import { workIsSettled } from "./workflow-gates";

test("observing no new action cannot hide a cancelled task's future wake or saved watch", () => {
  expect(workIsSettled([{ status: "waiting", nextCheckAt: "2026-10-28T17:00:00Z" }], [])).toBe(false);
  expect(workIsSettled([{ status: "stopped", nextCheckAt: null }], [{ enabled: true, deletedAt: null }])).toBe(false);
  expect(workIsSettled([{ status: "stopped", nextCheckAt: null }], [{ enabled: false, deletedAt: null }])).toBe(true);
  expect(workIsSettled([{ status: "completed", nextCheckAt: null }], [])).toBe(true);
});
