import { describe, expect, test } from "bun:test";
import { toggleMessageReaction } from "../src";

describe("toggleMessageReaction", () => {
  test("keeps different emoji from the same actor", () => {
    const first = toggleMessageReaction([], "👍", "agent");
    const second = toggleMessageReaction(first.reactions, "❤️", "agent");

    expect(second.removed).toBe(false);
    expect(second.reactions).toEqual([
      { by: "agent", emoji: "👍" },
      { by: "agent", emoji: "❤️" },
    ]);
  });

  test("removes only the matching emoji and actor pair", () => {
    const current = [
      { by: "agent", emoji: "👍" },
      { by: "agent", emoji: "❤️" },
      { by: "me", emoji: "👍" },
    ];

    expect(toggleMessageReaction(current, "👍", "agent")).toEqual({
      reactions: [
        { by: "agent", emoji: "❤️" },
        { by: "me", emoji: "👍" },
      ],
      removed: true,
    });
  });
});
