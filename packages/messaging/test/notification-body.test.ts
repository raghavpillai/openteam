import { describe, expect, test } from "bun:test";
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
