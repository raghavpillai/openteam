import { describe, expect, test } from "bun:test";
import { reactionNotificationBody, toggleMessageReaction } from "../src";
import { messageNotificationBody } from "../src/notifications";

const message = (content: string, metadata: Record<string, unknown> = {}) => ({
  id: "message",
  channelId: "chat",
  sequence: 1n,
  senderBotId: "bot",
  sourceRunId: null,
  content,
  metadata,
});
const asset = (fileName: string, mimeType: string, kind: string) => ({
  assetId: fileName.charCodeAt(0).toString(16).padStart(64, "0"),
  fileName,
  mimeType,
  byteSize: 10,
  kind,
});

describe("messageNotificationBody", () => {
  test("shows the first line with text as plain text, never Markdown", () => {
    expect(
      messageNotificationBody(
        message(
          "## **Deploy** finished — see [the logs](https://example.com/logs) and `run.sh`\n\n- step one"
        )
      )
    ).toBe("Deploy finished — see the logs and run.sh");
    expect(messageNotificationBody(message("```\n\n> *Quoted* reply"))).toBe("Quoted reply");
  });

  test("uses the chat list's wording for attachments, cards and drafts", () => {
    const images = [asset("a.png", "image/png", "image"), asset("b.png", "image/png", "image")];
    expect(messageNotificationBody(message("", { type: "attachment", attachments: images }))).toBe(
      "Sent 2 images"
    );
    expect(
      messageNotificationBody(
        message("Here's the **report**", {
          attachments: [asset("report.pdf", "application/pdf", "file")],
        })
      )
    ).toBe("Here's the report");
    expect(messageNotificationBody(message("Deploy to production?", { type: "widget" }))).toBe(
      "Deploy to production?"
    );
    expect(
      messageNotificationBody(message("Secret requested: GITHUB_TOKEN", { type: "secret-request" }))
    ).toBe("Secret requested: GITHUB_TOKEN");
    expect(messageNotificationBody(message("Q3 numbers", { type: "external-draft" }))).toBe(
      "Q3 numbers"
    );
    expect(messageNotificationBody(message(""))).toBe("");
  });
});

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
