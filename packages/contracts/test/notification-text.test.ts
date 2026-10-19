import { describe, expect, test } from "bun:test";
import {
  agentNotificationPresentation,
  notificationGraphemes,
  truncateNotificationText,
} from "../src";

describe("notification text", () => {
  test("defines one exact presentation and delivery policy for every agent notification type", () => {
    expect(
      agentNotificationPresentation({
        kind: "message",
        botName: "  Probe  ",
        body: "  Finished\nthe   command  ",
      })
    ).toEqual({ title: "Probe", body: "Finished the command", sound: "default" });
    expect(agentNotificationPresentation({ kind: "message", botName: "Probe" })).toEqual({
      title: "Probe",
      body: "Open OpenTeam to see what it did.",
      sound: "default",
    });
    expect(agentNotificationPresentation({ kind: "reaction", botName: "" })).toEqual({
      title: "OpenTeam",
      body: "Reacted to your message.",
      sound: "default",
    });
  });

  test("keeps extended grapheme clusters intact at the 140-character boundary", () => {
    const family = "👨‍👩‍👧‍👦";
    const value = truncateNotificationText(family.repeat(145));
    expect(notificationGraphemes(value)).toHaveLength(140);
    expect(value.endsWith("…")).toBe(true);
    expect(value.slice(0, -1)).toBe(family.repeat(139));
  });

  test("bounded preview work preserves the original text for ASCII, Unicode, and edge limits", () => {
    const inputs = [
      "",
      " \nhello\t world ",
      "plain text ".repeat(20_000),
      "👨‍👩‍👧‍👦".repeat(150),
      "e\u0301".repeat(150),
      "你好🇺🇸👩🏽‍💻".repeat(150),
    ];
    for (const input of inputs) {
      const graphemes = notificationGraphemes(input);
      for (const limit of [0, 1, 2, 2.5, 5, 140, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const previous =
          graphemes.length <= limit
            ? graphemes.join("")
            : `${graphemes.slice(0, Math.max(0, limit - 1)).join("")}…`;
        expect(truncateNotificationText(input, limit)).toBe(previous);
      }
    }
  });
});
