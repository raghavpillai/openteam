import { describe, expect, test } from "bun:test";
import { ReplySwipe } from "../src/reply-swipe";

describe("reply swipe feedback and commitment", () => {
  test("a slow drag cues once at the threshold, with no second cue on release", () => {
    const swipe = new ReplySwipe();
    expect([10, 40, 51, 52, 65].map((distance) => swipe.move(distance))).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(swipe.release(65, 0)).toEqual({ open: true, signal: false });
  });
  test("a short fast flick gets the same single cue at commitment", () => {
    const swipe = new ReplySwipe();
    expect(swipe.move(28)).toBe(false);
    expect(swipe.release(28, 0.7)).toEqual({ open: true, signal: true });
  });
  test("a short, slow or backwards gesture does not cue or open a reply", () => {
    for (const [distance, velocity] of [
      [23, 1],
      [30, 0.2],
      [-60, -1],
      [30, -1],
    ]) {
      const swipe = new ReplySwipe();
      expect(swipe.move(distance!)).toBe(false);
      expect(swipe.release(distance!, velocity!)).toEqual({ open: false, signal: false });
    }
  });
  test("small movement around the threshold keeps the reply armed without buzzing again", () => {
    const swipe = new ReplySwipe();
    expect(swipe.move(52)).toBe(true);
    expect(swipe.move(48)).toBe(false);
    expect(swipe.move(54)).toBe(false);
    expect(swipe.release(45, 0)).toEqual({ open: true, signal: false });
  });
  test("deliberately retreating below the reset boundary cancels the reply", () => {
    const swipe = new ReplySwipe();
    expect(swipe.move(60)).toBe(true);
    expect(swipe.move(39)).toBe(false);
    expect(swipe.release(39, 0)).toEqual({ open: false, signal: false });
  });
  test("retreating and rearming within one gesture never duplicates feedback", () => {
    const swipe = new ReplySwipe();
    expect([60, 20, 60, 20, 60].map((distance) => swipe.move(distance))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(swipe.release(60, 0)).toEqual({ open: true, signal: false });
  });
  test("release still cues if a final move event did not arrive", () => {
    const swipe = new ReplySwipe();
    expect(swipe.release(60, 0)).toEqual({ open: true, signal: true });
  });
  test("termination clears the gesture for the next interaction", () => {
    const swipe = new ReplySwipe();
    swipe.move(60);
    swipe.reset();
    expect(swipe.release(10, 0)).toEqual({ open: false, signal: false });
    expect(swipe.move(60)).toBe(true);
    expect(swipe.release(60, 0)).toEqual({ open: true, signal: false });
    expect(swipe.move(60)).toBe(true);
  });
});
