import { describe, expect, test } from "bun:test";
import { agentNotificationPresentation } from "@openteam/contracts";
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
  test("matches the actual Grok question notification title and body", () => {
    // Read from macOS usernoted history for the isolated Grok Bot 1.0.1 test.
    const { title, body } = agentNotificationPresentation({
      kind: "message",
      botName: "Question Lifecycle QA Nov13",
      body: messageNotificationBody(message("Fallback content", {
        type: "widget",
        widget: {
          prompt: "BANNER TEST: Which sample animal?",
          helpText: "Extra help text for the card.",
          options: [{ label: "Cat", value: "Cat" }, { label: "Dog", value: "Dog" }],
        },
      })),
    });
    expect({ title, body }).toEqual({
      title: "Question Lifecycle QA Nov13",
      body: "BANNER TEST: Which sample animal?",
    });
  });

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
    expect(messageNotificationBody(message("Fallback content", {
      type: "widget",
      widget: {
        prompt: "Which **color**?",
        helpText: "Choose a sample",
        options: [{ label: "Red" }, { label: "Blue" }],
      },
    }))).toBe("Which color?");
    expect(
      messageNotificationBody(message("Secret requested: GITHUB_TOKEN", { type: "secret-request" }))
    ).toBe("Secret requested: GITHUB_TOKEN");
    expect(messageNotificationBody(message("Q3 numbers", { type: "external-draft" }))).toBe(
      "Q3 numbers"
    );
    expect(messageNotificationBody(message(""))).toBe("");
  });
});
