import { describe, expect, test } from "bun:test";
import { reactionNotificationBody, toggleMessageReaction } from "../src";

describe("toggleMessageReaction", () => {
  test("a different emoji replaces the same actor's prior tapback", () => {
    const first = toggleMessageReaction([], "👍", "agent");
    const second = toggleMessageReaction(first.reactions, "❤️", "agent");

    expect(second.removed).toBe(false);
    expect(second.reactions).toEqual([
      { by: "agent", emoji: "❤️" },
    ]);
  });

  test("repeating an actor's emoji clears their legacy selections and preserves other actors", () => {
    const current = [
      { by: "agent", emoji: "👍" },
      { by: "agent", emoji: "❤️" },
      { by: "me", emoji: "👍" },
    ];

    expect(toggleMessageReaction(current, "👍", "agent")).toEqual({
      reactions: [
        { by: "me", emoji: "👍" },
      ],
      removed: true,
    });
  });
});

describe("reactionNotificationBody", () => {
  test("quotes the reacted-to message as plain text", () => {
    expect(reactionNotificationBody("👍", "**Ship it** on [Friday](https://example.com)\nThanks")).toBe(
      "Reacted 👍 to “Ship it on Friday”"
    );
    expect(reactionNotificationBody("❤️", "")).toBe("Reacted ❤️ to your message");
    expect(reactionNotificationBody("❤️", "```\n```")).toBe("Reacted ❤️ to your message");
  });
});
