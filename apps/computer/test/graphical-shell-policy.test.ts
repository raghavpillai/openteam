import { describe, expect, test } from "bun:test";
import {
  assertGraphicalShellBoundary,
  graphicalShellBoundaryViolation,
} from "../src/graphical-shell-policy";

describe("graphical Shell capability boundary", () => {
  test("blocks ordinary agents from selecting displays or injecting input", () => {
    for (const command of [
      "DISPLAY=:105 xdotool click 40 40",
      "export XAUTHORITY=/tmp/auth && xte 'mousemove 1 1'",
      "ls /tmp/.X11-unix",
      "openteam-screen-launch chromium https://example.com",
      "wmctrl -a Chromium",
      "xvkbd -text secret",
      "xinput set-prop 12 enabled 0",
    ]) {
      expect(() => assertGraphicalShellBoundary(command, null)).toThrow(
        "Graphical Shell access is unavailable"
      );
    }
  });

  test("blocks raw CDP discovery and attachment outside computerUse", () => {
    for (const command of [
      "curl http://127.0.0.1:9305/json/version",
      "curl http://127.1:9305/json/version",
      "curl http://[::1]:9305/json/version",
      "nc -z 127.0.0.1 9305",
      "node attach.js --remote-debugging-port=9305",
      "node -e 'chromium.connectOverCDP(endpoint)'",
      "pgrep -a chromium",
    ]) {
      expect(graphicalShellBoundaryViolation(command, "browserUse")).not.toBeNull();
      expect(graphicalShellBoundaryViolation(command, null)).not.toBeNull();
    }
  });

  test("preserves ordinary terminal work and computerUse recovery access", () => {
    expect(graphicalShellBoundaryViolation("bun test && git status --short", null)).toBeNull();
    expect(
      graphicalShellBoundaryViolation(
        "openteam-screen-launch chromium 'https://example.com'",
        "computerUse"
      )
    ).toBeNull();
    expect(
      graphicalShellBoundaryViolation("node -e 'chromium.connectOverCDP(endpoint)'", "computerUse")
    ).toBeNull();
  });
});
