import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { bindWindowActivity, windowIsActive, windowIsVisible } from "../src/main/window-activity";

function host() {
  const state = { shown: true, minimized: false, focused: true };
  const sent: Array<[string, boolean]> = [];
  const webContents = Object.assign(new EventEmitter(), { send: (channel: string, value: boolean) => sent.push([channel, value]) });
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => state.shown, isMinimized: () => state.minimized, isFocused: () => state.focused, webContents,
  });
  return { state, sent, window, stop: bindWindowActivity(window as unknown as Parameters<typeof bindWindowActivity>[0]) };
}

describe("native desktop activity", () => {
  test("all visibility/focus combinations use native state", () => {
    const { state, window, stop } = host();
    for (const shown of [false, true]) for (const minimized of [false, true]) for (const focused of [false, true]) {
      Object.assign(state, { shown, minimized, focused });
      expect(windowIsVisible(window)).toBe(shown && !minimized);
      expect(windowIsActive(window)).toBe(shown && !minimized && focused);
    }
    stop();
  });
  test("focus/blur publish activity without changing notification visibility", () => {
    const { state, sent, window, stop } = host();
    state.focused = false; window.emit("blur");
    state.focused = true; window.emit("focus");
    expect(sent).toEqual([["openteam:window-activity-changed", false], ["openteam:window-activity-changed", true]]);
    stop();
  });
  test("hide, minimize, restore, show and reload publish both signals", () => {
    const { state, sent, window, stop } = host();
    state.shown = false; window.emit("hide");
    state.shown = true; state.minimized = true; window.emit("minimize");
    state.minimized = false; state.focused = false; window.emit("restore");
    state.focused = true; window.emit("show");
    window.webContents.emit("did-finish-load");
    expect(sent).toEqual([
      ["openteam:window-activity-changed", false], ["openteam:window-visibility-changed", false],
      ["openteam:window-activity-changed", false], ["openteam:window-visibility-changed", false],
      ["openteam:window-activity-changed", false], ["openteam:window-visibility-changed", true],
      ["openteam:window-activity-changed", true], ["openteam:window-visibility-changed", true],
      ["openteam:window-activity-changed", true], ["openteam:window-visibility-changed", true],
    ]);
    stop();
  });
  test("disposing removes native and webContents listeners", () => {
    const { sent, window, stop } = host();
    const webContents = window.webContents;
    Object.defineProperty(window, "webContents", { get() { throw Error("Object has been destroyed"); } });
    stop(); stop();
    for (const event of ["show", "hide", "minimize", "restore", "focus", "blur"]) {
      expect(window.listenerCount(event)).toBe(0);
      window.emit(event);
    }
    expect(webContents.listenerCount("did-finish-load")).toBe(0);
    webContents.emit("did-finish-load");
    expect(sent).toHaveLength(0);
  });
});
