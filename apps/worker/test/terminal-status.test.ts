import { describe, expect, test } from "bun:test";
import { TurnStoppedError, turnCompletionFailure } from "../src/worker";

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

  test("a stopped turn reads as a stop, not a failure", () => {
    const failure = turnCompletionFailure({ type: "turn.completed", turnId: "run-4", status: "cancelled" });
    expect(failure).toBeInstanceOf(TurnStoppedError);
    expect(failure?.message).toBe("Computer turn ended with status cancelled");
    expect(turnCompletionFailure({ type: "turn.completed", turnId: "run-5", status: "interrupted" })).not.toBeInstanceOf(TurnStoppedError);
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
