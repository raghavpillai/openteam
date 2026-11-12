import { expect, test } from "bun:test";
import {
  validateTaskProgress,
} from "../src/task-progress";

const now = Date.parse("2026-01-01T00:00:00Z");
const milestone = () => ({
  key: "phase-1",
  state: "working" as const,
  summary: "The export is generated",
  evidence: ["/exports/receipt-1"],
  remaining: ["Verify delivery"],
  nextAction: "Check destination receipt",
});
test("acknowledgements and premature completion cannot replace evidence and obligations", () => {
  expect(() => validateTaskProgress({ ...milestone(), evidence: [] }, now)).toThrow("evidence");
  expect(() => validateTaskProgress({ ...milestone(), state: "complete" }, now)).toThrow(
    "unresolved"
  );
  expect(() => validateTaskProgress({ ...milestone(), nextAction: " " }, now)).toThrow(
    "nextAction"
  );
});
test("progress records cannot grow into unbounded transcripts", () => {
  expect(() =>
    validateTaskProgress({ ...milestone(), evidence: Array(20).fill("x".repeat(2000)) }, now)
  ).toThrow("32000");
});
