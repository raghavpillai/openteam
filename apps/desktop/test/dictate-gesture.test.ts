import { describe, expect, test } from "bun:test";
import { createDictateGesture, DICTATE_DOUBLE_MS, DICTATE_TAP_MS } from "../src/renderer/hooks/dictate-gesture";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in recorder: records what the gesture asked for, with a clock for elapsed time. */
const recorder = (startState = "recording") => {
  const calls: string[] = [];
  let state = "idle";
  let startedAt = 0;
  const target = {
    state: () => state,
    active: () => state === startState,
    start: () => { calls.push("start"); state = startState; startedAt = Date.now(); },
    stop: () => { calls.push("stop"); state = "processing"; },
    cancel: () => { calls.push("cancel"); state = "idle"; },
    elapsedMs: () => (state === "recording" ? Date.now() - startedAt : 0),
    tooEarly: () => calls.push("tooEarly"),
  };
  return { calls, target, gesture: createDictateGesture(target), endTranscription: () => { state = "idle"; } };
};

describe("dictate shortcut gesture", () => {
  test("hold transcribes on release, ignores presses while transcribing, then starts over", async () => {
    const { calls, gesture, endTranscription } = recorder();
    gesture.press();
    await wait(DICTATE_TAP_MS + 300);
    gesture.release();
    gesture.press();
    expect(calls).toEqual(["start", "stop"]);
    endTranscription();
    gesture.press();
    expect(calls).toEqual(["start", "stop", "start"]);
  });

  test("a single quick tap records nothing; a double press stays hands-free until pressed again", async () => {
    const tap = recorder();
    tap.gesture.press();
    await wait(60);
    tap.gesture.release();
    await wait(DICTATE_DOUBLE_MS + 80);
    expect(tap.calls).toEqual(["start", "cancel"]);

    const { calls, gesture } = recorder();
    gesture.press();
    gesture.release();
    await wait(120);
    gesture.press();
    gesture.release();
    await wait(DICTATE_DOUBLE_MS + 400);
    expect(calls).toEqual(["start"]);
    gesture.press();
    expect(calls).toEqual(["start", "stop"]);
  });

  test("letting go of a hold before the microphone is live says so instead of vanishing", async () => {
    const { calls, gesture } = recorder("requesting");
    gesture.press();
    await wait(DICTATE_TAP_MS + 50);
    gesture.release();
    expect(calls).toEqual(["start", "tooEarly"]);
  });

  test("Fn+key aborts the hold it began; a mic-button recording ends on a press", async () => {
    const held = recorder();
    held.gesture.press();
    held.gesture.abort();
    expect(held.calls).toEqual(["start", "cancel"]);

    const { calls, target, gesture } = recorder();
    target.start();
    await wait(600);
    gesture.press();
    expect(calls).toEqual(["start", "stop"]);
  });
});
