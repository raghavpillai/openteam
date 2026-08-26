import { describe, expect, test } from "bun:test";
import { turnCompletionFailure } from "../src/worker";

describe("authoritative computer turn completion", () => {
  test("accepts only completed turns", () => {
    expect(
      turnCompletionFailure({
        type: "turn.completed",
        turnId: "run-1",
        status: "completed",
      })
    ).toBeNull();

    expect(
      turnCompletionFailure({
        type: "turn.completed",
        turnId: "run-2",
        status: "interrupted",
      })?.message
    ).toBe("Computer turn ended with status interrupted");
  });

  test("preserves the runtime failure message", () => {
    expect(
      turnCompletionFailure({
        type: "turn.completed",
        turnId: "run-3",
        status: "failed",
        error: { message: "OAuth module could not load" },
      })?.message
    ).toBe("OAuth module could not load");
  });
});
