import { describe, expect, test } from "bun:test";
import {
  resolveBotAvatarMark,
} from "../src";
import { ROBOT_AVATAR_LABELS, ROBOT_AVATAR_SHAPES, normalizeRobotAvatarShape } from "../src/robot-avatar";

describe("bot avatar dealing", () => {

  test("preserves custom six-digit picker colors instead of silently assigning another color", () => {
    for (const avatarColor of ["#93643A", "#FF6600", "#000000", "#FFFFFF"]) {
      expect(
        resolveBotAvatarMark({ agentId: "picker-test", avatarShape: "chip", avatarColor }).color
      ).toBe(avatarColor.toLowerCase());
    }
  });

});

test("robot IDs round-trip, normalize case and default unknown or retired names", () => {
  for (const shape of ROBOT_AVATAR_SHAPES) {
    expect(normalizeRobotAvatarShape(shape)).toBe(shape);
    expect(shape.length).toBeLessThanOrEqual(16);
    expect(ROBOT_AVATAR_LABELS[shape]).toBeTruthy();
  }
  expect(normalizeRobotAvatarShape(" HEX-VISOR ")).toBe("hex-visor");
  for (const value of [undefined, null, "", "unknown", "__proto__", "constructor", "circle", "cloud"])
    expect(normalizeRobotAvatarShape(value)).toBe("chip");
});
