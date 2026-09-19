import { expect, test } from "bun:test";
import { sendProgressOwner, sendProgressRevealDelay } from "../../src/renderer/lib/send-progress";

const attempt = (nonce: string, createdAtMs: number, dispatchStartedAtMs: number) => ({
  nonce,
  createdAtMs,
  dispatchStartedAtMs,
  phase: "dispatching" as const,
});

test("one progress indicator follows the newest pending message without restarting the oldest attempt", () => {
  const older = attempt("older", 100, 150);
  const newer = attempt("newer", 200, 240);
  expect(sendProgressOwner([newer, older])).toEqual({ nonce: "newer", sinceMs: 150 });
  expect(sendProgressOwner([{ ...newer, phase: "accepted-awaiting-echo" }, older])).toEqual({
    nonce: "older",
    sinceMs: 150,
  });
  expect(sendProgressOwner([newer, { ...older, phase: "failed" }])).toEqual({
    nonce: "newer",
    sinceMs: 240,
  });
});

test("queued, prepared, accepted, and failed messages never own sending progress", () => {
  const record = attempt("message", 100, 150);
  for (const phase of ["prepared", "queued", "accepted-awaiting-echo", "failed"] as const) {
    expect(sendProgressOwner([{ ...record, phase }])).toBeNull();
  }
  expect(sendProgressOwner([{ ...record, dispatchStartedAtMs: null }])).toBeNull();
  expect(sendProgressOwner([])).toBeNull();
});

test("restoring a pending message uses elapsed send time, not another full delay", () => {
  expect(sendProgressRevealDelay(1_000, 1_000)).toBe(2_000);
  expect(sendProgressRevealDelay(1_000, 2_500)).toBe(500);
  expect(sendProgressRevealDelay(1_000, 3_500)).toBe(0);
});
