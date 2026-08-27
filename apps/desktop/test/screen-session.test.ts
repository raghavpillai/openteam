import { describe, expect, test } from "bun:test";
import {
  enableScreenForSession,
  shouldLoadScreenStatus,
  shouldPollScreenStatus,
  shouldRefreshScreenFrame,
} from "../src/renderer/lib/screen-session";

describe("screen session activity", () => {
  test("remembers an enabled screen without mutating the prior session", () => {
    const initial = new Set(["bot-a"]);
    const enabled = enableScreenForSession(initial, "bot-b");

    expect([...initial]).toEqual(["bot-a"]);
    expect([...enabled]).toEqual(["bot-a", "bot-b"]);
    expect(enableScreenForSession(enabled, "bot-b")).toBe(enabled);
  });

  test("does no screen work before the user enables it", () => {
    expect(shouldLoadScreenStatus(false, true)).toBe(false);
    expect(shouldPollScreenStatus(false, true, undefined)).toBe(false);
    expect(
      shouldRefreshScreenFrame({
        enabled: false,
        inspectorActive: true,
        documentVisible: true,
        viewerOpen: false,
        state: "ready",
      })
    ).toBe(false);
  });

  test("keeps the session enabled while suspending hidden and redundant work", () => {
    expect(shouldLoadScreenStatus(true, false)).toBe(false);
    expect(shouldPollScreenStatus(true, false, "starting")).toBe(false);
    expect(
      shouldRefreshScreenFrame({
        enabled: true,
        inspectorActive: false,
        documentVisible: true,
        viewerOpen: false,
        state: "ready",
      })
    ).toBe(false);
    expect(
      shouldRefreshScreenFrame({
        enabled: true,
        inspectorActive: true,
        documentVisible: true,
        viewerOpen: true,
        state: "ready",
      })
    ).toBe(false);
    expect(
      shouldRefreshScreenFrame({
        enabled: true,
        inspectorActive: true,
        documentVisible: false,
        viewerOpen: false,
        state: "ready",
      })
    ).toBe(false);
  });

  test("refreshes an enabled ready preview when it becomes visible", () => {
    expect(shouldLoadScreenStatus(true, true)).toBe(true);
    expect(shouldPollScreenStatus(true, true, "starting")).toBe(true);
    expect(shouldPollScreenStatus(true, true, "ready")).toBe(false);
    expect(
      shouldRefreshScreenFrame({
        enabled: true,
        inspectorActive: true,
        documentVisible: true,
        viewerOpen: false,
        state: "ready",
      })
    ).toBe(true);
  });
});
