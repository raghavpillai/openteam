import { describe, expect, test } from "bun:test";
import {
  ChatScrollState,
  enteringAppendedMessageKeys,
  highestVisibleSequence,
  isNearLiveEdge,
} from "../src/chat-viewport";

describe("mobile chat viewport coordination", () => {
  test("reaching newest cues once during a deliberate drag and its momentum", () => {
    const state = new ChatScrollState();
    state.beginDrag();
    expect(state.observeScroll(900, 800, 2000, false)).toBe(false);
    expect(state.observeScroll(1150, 800, 2000, false)).toBe(false);
    state.endDrag();
    state.beginMomentum();
    expect(state.observeScroll(1198, 800, 2000, false)).toBe(true);
    expect(state.observeScroll(1210, 800, 2000, false)).toBe(false);
    expect(state.observeScroll(1100, 800, 2000, false)).toBe(false);
    expect(state.observeScroll(1200, 800, 2000, false)).toBe(false);
    state.endMomentum();
    state.beginDrag();
    expect(state.observeScroll(1100, 800, 2000, false)).toBe(false);
    expect(state.observeScroll(1200, 800, 2000, false)).toBe(true);
  });

  test("initial layout, automatic following, overscroll and paged history stay quiet", () => {
    const state = new ChatScrollState();
    expect(state.observeScroll(900, 800, 2000, false)).toBe(false);
    expect(state.observeScroll(1200, 800, 2000, false)).toBe(false);
    state.beginDrag();
    for (const offset of [1200, 1210, 1190, 1200]) {
      expect(state.observeScroll(offset, 800, 2000, false)).toBe(false);
    }
    state.beginDrag();
    expect(state.observeScroll(900, 800, 2000, true)).toBe(false);
    expect(state.observeScroll(1200, 800, 2000, true)).toBe(false);
    state.beginDrag();
    expect(state.observeScroll(-40, 800, 500, false)).toBe(false);
    expect(state.observeScroll(0, 800, 500, false)).toBe(false);
  });

  test("jumping, sending or changing chat cancels pending scroll feedback", () => {
    for (const following of [true, false]) {
      const state = new ChatScrollState();
      state.beginDrag();
      state.observeScroll(900, 800, 2000, false);
      state.setFollowing(following);
      state.beginMomentum();
      expect(state.observeScroll(1200, 800, 2000, false)).toBe(false);
      state.reset(true);
      expect(state.observeScroll(1200, 800, 2000, false)).toBe(false);
    }
  });

  test("the measured bottom includes composer padding and clamps short conversations", () => {
    const state = new ChatScrollState();
    state.contentHeight = 2_080; // 2,000 points of rows plus 80 of composer clearance.
    state.viewportHeight = 800;
    expect(state.bottomOffset).toBe(1_280);
    state.contentHeight = 500;
    expect(state.bottomOffset).toBe(0);
  });

  test("opening history, resizing the keyboard, and growing a message keep following", () => {
    const state = new ChatScrollState();
    state.observeScroll(0, 800, 12_000, false);
    state.observeScroll(11_200, 450, 12_000, false);
    state.observeScroll(11_550, 450, 12_800, false);
    expect(state.following).toBe(true);
  });

  test("a reader's drag pauses corrections and momentum can return to the live edge", () => {
    const state = new ChatScrollState();
    state.beginDrag();
    state.observeScroll(1_000, 800, 2_000, false);
    state.endDrag();
    expect(state.following).toBe(false);
    // Layout-induced events cannot pull a reader away from older messages.
    state.observeScroll(1_200, 800, 2_000, false);
    expect(state.following).toBe(false);
    state.beginMomentum();
    state.observeScroll(1_200, 800, 2_000, false);
    state.endMomentum();
    expect(state.following).toBe(true);
  });

  test("deep links and paged history stay anchored until the user requests latest", () => {
    const state = new ChatScrollState();
    state.reset(false);
    state.observeScroll(1_200, 800, 2_000, false);
    expect(state.following).toBe(false);
    state.beginDrag();
    state.observeScroll(1_200, 800, 2_000, true);
    state.endDrag();
    expect(state.following).toBe(false);
    state.setFollowing(true); // Sending a message or tapping Jump to latest.
    state.beginMomentum(); // Programmatic scrolling is not a user gesture.
    state.observeScroll(100, 800, 2_000, false);
    expect(state.following).toBe(true);
  });

  test("starting a drag cancels the intent of any pending bottom correction", () => {
    const state = new ChatScrollState();
    state.beginDrag();
    expect(state.following).toBe(false);
    state.observeScroll(1_199, 800, 2_000, false);
    expect(state.following).toBe(true);
    expect(state.canCorrect).toBe(false); // Even a drag within the threshold must not be interrupted.
    state.endDrag();
    expect(state.canCorrect).toBe(true);
    state.reset(true);
    state.contentHeight = 2_000;
    state.viewportHeight = 800;
    state.reset(false);
    expect(state.bottomOffset).toBe(1_200); // Reusing a route need not fire onLayout again.
  });
  test("acknowledges only the highest actually visible numeric sequence", () => {
    expect(
      highestVisibleSequence([
        { isViewable: true, item: { sequence: "41" } },
        { isViewable: false, item: { sequence: "99" } },
        { isViewable: true, item: { sequence: "43" } },
        { isViewable: true, item: { sequence: "local-pending" } },
      ])
    ).toBe("43");
  });

  test("distinguishes the live edge from reading older history", () => {
    expect(isNearLiveEdge(1_120, 800, 2_000)).toBe(false);
    expect(isNearLiveEdge(1_150, 800, 2_000)).toBe(true);
  });

  test("does not animate prepended history but does animate appended messages", () => {
    const known = new Set(["message-10", "message-11"]);
    const keys = enteringAppendedMessageKeys(
      [
        { id: "message-8" },
        { id: "message-9" },
        { id: "message-10" },
        { id: "message-11" },
        { id: "message-12" },
      ],
      known,
      (message) => message.id
    );

    expect([...keys]).toEqual(["message-12"]);
  });
});
