import { describe, expect, test } from "bun:test";
import {
  enteringAppendedMessageKeys,
  highestVisibleSequence,
  isNearLiveEdge,
} from "../src/chat-viewport";

describe("mobile chat viewport coordination", () => {
  test("acknowledges only the highest actually visible numeric sequence", () => {
    expect(
      highestVisibleSequence([
        { isViewable: true, item: { sequence: "41" } },
        { isViewable: false, item: { sequence: "99" } },
        { isViewable: true, item: { sequence: "43" } },
        { isViewable: true, item: { sequence: "local-pending" } },
      ])
    ).toBe("43");
  });

  test("distinguishes the live edge from reading older history", () => {
    expect(isNearLiveEdge(1_120, 800, 2_000)).toBe(false);
    expect(isNearLiveEdge(1_150, 800, 2_000)).toBe(true);
  });

  test("does not animate prepended history but does animate appended messages", () => {
    const known = new Set(["message-10", "message-11"]);
    const keys = enteringAppendedMessageKeys(
      [
        { id: "message-8" },
        { id: "message-9" },
        { id: "message-10" },
        { id: "message-11" },
        { id: "message-12" },
      ],
      known,
      (message) => message.id
    );

    expect([...keys]).toEqual(["message-12"]);
  });
});
