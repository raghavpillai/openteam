import { describe, expect, test } from "bun:test";
import { mobileFixture } from "../src/fixtures";
import { searchClientSnapshot } from "../src/search";

describe("mobile fixture search", () => {
  test("finds message content and preserves its navigation target", () => {
    const response = searchClientSnapshot(mobileFixture, "iPhone experience", "messages");

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      kind: "message",
      channelId: "channel-research",
      messageId: "message-2",
    });
  });

  test("keeps empty All results focused on navigable bots and chats", () => {
    const response = searchClientSnapshot(mobileFixture, "", "all");

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((result) => ["bot", "channel"].includes(result.kind))).toBe(true);
  });

  test("separates files and links into swipeable categories", () => {
    const snapshot = structuredClone(mobileFixture);
    snapshot.channelMessages.push({
      id: "message-search-assets",
      sequence: "99",
      channelId: "channel-build",
      sender: "agent",
      senderBotId: "bot-build",
      sourceRunId: null,
      content: "Review https://example.com/mobile-search before launch.",
      metadata: {
        attachments: [
          {
            assetId: "a".repeat(64),
            fileName: "mobile-search-notes.pdf",
            mimeType: "application/pdf",
            byteSize: 42,
            kind: "file",
          },
        ],
      },
      createdAt: "2026-08-29T18:00:00.000Z",
    });

    expect(searchClientSnapshot(snapshot, "mobile search", "files").results[0]).toMatchObject({
      kind: "file",
      channelId: "channel-build",
      messageId: "message-search-assets",
      title: "mobile-search-notes.pdf",
    });
    expect(searchClientSnapshot(snapshot, "example", "links").results[0]).toMatchObject({
      kind: "link",
      url: "https://example.com/mobile-search",
    });
  });
});
