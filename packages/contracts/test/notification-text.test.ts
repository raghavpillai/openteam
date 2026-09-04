import { describe, expect, test } from "bun:test";
import {
  agentNotificationPresentation,
  notificationGraphemes,
  notificationMessageInputReason,
  notificationMessagePreview,
  truncateNotificationText,
} from "../src";

describe("notification text", () => {
  test("defines one exact presentation and delivery policy for every agent notification type", () => {
    expect(
      agentNotificationPresentation({
        kind: "agent-needs-input",
        botName: "  Probe  ",
        body: "  Approve\nthis   command  ",
      })
    ).toEqual({
      title: "Probe needs you",
      body: "Approve this command",
      sound: "default",
      urgency: "critical",
    });
    expect(agentNotificationPresentation({ kind: "agent-needs-input", botName: "Probe" })).toEqual({
      title: "Probe needs you",
      body: "Waiting for your input.",
      sound: "default",
      urgency: "critical",
    });
    expect(
      agentNotificationPresentation({ kind: "agent-done", botName: "Probe", body: "Finished" })
    ).toEqual({
      title: "Probe",
      body: "Finished",
      sound: null,
      urgency: "normal",
    });
    expect(agentNotificationPresentation({ kind: "agent-done", botName: "Probe" })).toEqual({
      title: "Probe",
      body: "Open OpenTeam to see what it did.",
      sound: null,
      urgency: "normal",
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

  test("provides useful structured fallbacks for attachment-only messages", () => {
    expect(
      notificationMessagePreview({
        content: "",
        metadata: {
          attachments: [
            { kind: "image", mimeType: "image/png" },
            { kind: "image", mimeType: "image/jpeg" },
          ],
        },
      })
    ).toBe("Sent 2 images.");
    expect(notificationMessagePreview({ content: "", metadata: { type: "secret_request" } })).toBe(
      "Waiting for your input."
    );
  });

  test("classifies interactive and secret messages as needs-input reasons", () => {
    expect(
      notificationMessageInputReason({
        content: "Deploy to production?",
        metadata: { type: "widget" },
      })
    ).toBe("Deploy to production?");
    expect(
      notificationMessageInputReason({ content: "", metadata: { type: "secret-request" } })
    ).toBe("Waiting for your input.");
    expect(
      notificationMessageInputReason({
        content: "Deploy to production?",
        metadata: { type: "widget", respondedValue: "No" },
      })
    ).toBeNull();
    expect(
      notificationMessageInputReason({
        content: "Deploy to production?",
        metadata: { type: "widget", widgetDismissed: true },
      })
    ).toBeNull();
    expect(
      notificationMessageInputReason({
        content: "Secret requested",
        metadata: { type: "secret-request", secretProvided: true },
      })
    ).toBeNull();
    expect(
      notificationMessagePreview({
        content: "Deploy to production?",
        metadata: { type: "widget", widgetDismissed: true },
      })
    ).toBe("Open OpenTeam to see what it did.");
    expect(
      notificationMessageInputReason({ content: "Finished", metadata: { type: "text" } })
    ).toBeNull();
  });
});
