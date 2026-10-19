import { describe, expect, test } from "bun:test";
import {
  agentNotificationPresentation,
  notificationGraphemes,
  notificationMessagePreview,
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
      body: "Sent you a message.",
      sound: "default",
    });
    expect(agentNotificationPresentation({ kind: "reaction", botName: "" })).toEqual({
      title: "OpenTeam",
      body: "Reacted to your message.",
      sound: "default",
    });
  });

  test("shows the first line with text as plain text, never Markdown", () => {
    expect(
      notificationMessagePreview({
        content: "## **Deploy** finished — see [the logs](https://example.com/logs) and `run.sh`\n\n- step one",
      })
    ).toBe("Deploy finished — see the logs and run.sh");
    expect(notificationMessagePreview({ content: "```\n\n> *Quoted* reply" })).toBe("Quoted reply");
    expect(
      notificationMessagePreview({
        content: "Here's the **report**",
        metadata: { attachments: [{ fileName: "report.pdf", kind: "file" }] },
      })
    ).toBe("Here's the report 📎 report.pdf");
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

  test("includes archive filenames without repeating an existing caption", () => {
    const metadata = { attachments: [{ fileName: "evidence.zip", kind: "file" }] };
    expect(notificationMessagePreview({ metadata })).toBe("Sent 1 archive. 📎 evidence.zip");
    expect(notificationMessagePreview({ content: "Sent 1 archive", metadata })).toBe("Sent 1 archive 📎 evidence.zip");
    expect(notificationMessagePreview({ content: "Attached evidence.zip", metadata })).toBe("Attached evidence.zip");
  });

  test("previews cards like any other message", () => {
    expect(
      notificationMessagePreview({
        content: "Deploy to production?",
        metadata: { type: "widget" },
      })
    ).toBe("Deploy to production?");
    expect(notificationMessagePreview({ content: "", metadata: { type: "widget" } })).toBe(
      "Asked you to answer a question."
    );
    expect(notificationMessagePreview({ content: "", metadata: { type: "secret-request" } })).toBe(
      "Waiting for your input."
    );
    expect(
      notificationMessagePreview({
        content: "Deploy to production?",
        metadata: { type: "widget", widgetDismissed: true },
      })
    ).toBe("Open OpenTeam to see what it did.");
  });
});
