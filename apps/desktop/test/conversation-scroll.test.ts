import { describe, expect, test } from "bun:test";
import {
  appendedTimelineEntryCount,
  conversationNoticeTransition,
  focusConversationViewport,
} from "../src/renderer/components/ai-elements/conversation";

describe("conversation new-message notices", () => {
  test("does not count cursor-paginated history as new", () => {
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 300,
        previousLatestKey: "message:newest",
        nextLatestKey: "message:newest",
        previousLatestMessageKey: "message:newest",
        nextLatestMessageKey: "message:newest",
      })
    ).toBe(0);
  });

  test("counts authoritative growth beneath a stable thinking row", () => {
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 203,
        previousLatestKey: "thinking:thinking-slot",
        nextLatestKey: "thinking:thinking-slot",
        previousLatestMessageKey: "message:old",
        nextLatestMessageKey: "message:new",
      })
    ).toBe(3);
  });

  test("does not count a replacement or a reset as an append", () => {
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 200,
        previousLatestKey: "approval:old",
        nextLatestKey: "message:new",
      })
    ).toBe(0);
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 100,
        previousLatestKey: "message:old",
        nextLatestKey: "message:new",
      })
    ).toBe(0);
  });

  test("resets notice state when the conversation changes", () => {
    expect(
      conversationNoticeTransition({
        previous: {
          conversationId: "channel-a",
          messageCount: 20,
          latestEntryKey: "thinking:thinking-slot",
          latestMessageKey: "message:old",
          trackNewMessages: true,
        },
        next: {
          conversationId: "channel-b",
          messageCount: 21,
          latestEntryKey: "thinking:thinking-slot",
          latestMessageKey: "message:new",
          trackNewMessages: true,
        },
        trackNewMessages: true,
      })
    ).toEqual({ appendedCount: 0, reset: true });
  });

  test("moves focus to the stable transcript viewport without changing scroll", () => {
    let receivedOptions: FocusOptions | undefined;
    const viewport = {
      focus: (options?: FocusOptions) => {
        receivedOptions = options;
      },
      hasAttribute: () => false,
      tabIndex: 0,
    };

    expect(focusConversationViewport(viewport)).toBe(true);
    expect(viewport.tabIndex).toBe(-1);
    expect(receivedOptions).toEqual({ preventScroll: true });
    expect(focusConversationViewport(null)).toBe(false);
  });
});
