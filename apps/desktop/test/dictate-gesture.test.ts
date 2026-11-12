import { describe, expect, test } from "bun:test";
import { createDictateGesture, DICTATE_DOUBLE_MS, DICTATE_TAP_MS } from "../src/renderer/hooks/dictate-gesture";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in recorder: records what the gesture asked for, with a clock for elapsed time. */
const recorder = () => {
  const calls: string[] = [];
  let state = "idle";
  let startedAt = 0;
  return {
    calls,
    target: {
      state: () => state,
      active: () => state === "recording",
      start: () => { calls.push("start"); state = "recording"; startedAt = Date.now(); },
      stop: () => { calls.push("stop"); state = "processing"; },
      cancel: () => { calls.push("cancel"); state = "idle"; },
      elapsedMs: () => (state === "recording" ? Date.now() - startedAt : 0),
    },
    endTranscription: () => { state = "idle"; },
  };
};

describe("dictate shortcut gesture", () => {
  test("hold: records while held, transcribes on release", async () => {
    const { calls, target } = recorder();
    const gesture = createDictateGesture(target);
    gesture.press();
    await wait(700);
    gesture.release();
    expect(calls).toEqual(["start", "stop"]);
  });

  test("a single quick tap records nothing", async () => {
    const { calls, target } = recorder();
    const gesture = createDictateGesture(target);
    gesture.press();
    await wait(60);
    gesture.release();
    await wait(DICTATE_DOUBLE_MS + 80);
    expect(calls).toEqual(["start", "cancel"]);
  });

  test("double press: keeps recording hands-free until pressed again", async () => {
    const { calls, target } = recorder();
    const gesture = createDictateGesture(target);
    gesture.press();
    await wait(60);
    gesture.release();
    await wait(120);
    gesture.press();
    await wait(60);
    gesture.release();
    await wait(DICTATE_DOUBLE_MS + 400);
    expect(calls).toEqual(["start"]);
    gesture.press();
    gesture.release();
    expect(calls).toEqual(["start", "stop"]);
  });

  test("a short hold (past a tap, under the minimum) drops quietly", async () => {
    const { calls, target } = recorder();
    const gesture = createDictateGesture(target);
    gesture.press();
    await wait(DICTATE_TAP_MS + 50);
    gesture.release();
    expect(calls).toEqual(["start", "cancel"]);
  });

  test("Fn+key aborts the hold it began; the mic button's recording ends on a press", async () => {
    const first = recorder();
    const gesture = createDictateGesture(first.target);
    gesture.press();
    gesture.abort();
    expect(first.calls).toEqual(["start", "cancel"]);

    const second = recorder();
    const other = createDictateGesture(second.target);
    second.target.start();
    await wait(600);
    other.press();
    expect(second.calls).toEqual(["start", "stop"]);
  });

  test("ignores presses while transcribing, and starts over once it's done", async () => {
    const { calls, target, endTranscription } = recorder();
    const gesture = createDictateGesture(target);
    gesture.press();
    await wait(600);
    gesture.release();
    gesture.press();
    expect(calls).toEqual(["start", "stop"]);
    endTranscription();
    gesture.press();
    expect(calls).toEqual(["start", "stop", "start"]);
  });
});
