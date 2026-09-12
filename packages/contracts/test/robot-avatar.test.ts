import { expect, test } from "bun:test";
import { BOT_AVATAR_SHAPES } from "../src/bot-avatar";
import {
  ROBOT_AVATAR_SHAPES,
  ROBOT_AVATAR_LABELS,
  normalizeRobotAvatarShape,
} from "../src/robot-avatar";

test("robot IDs round-trip through the profile contract", () => {
  for (const shape of ROBOT_AVATAR_SHAPES) {
    expect(normalizeRobotAvatarShape(shape)).toBe(shape);
    expect(shape.length).toBeLessThanOrEqual(16);
    expect(ROBOT_AVATAR_LABELS[shape]).toBeTruthy();
  }
  for (const shape of BOT_AVATAR_SHAPES) {
    expect(ROBOT_AVATAR_SHAPES).toContain(normalizeRobotAvatarShape(shape));
  }
});

test("normalization accepts legacy values and safely defaults unknown stored strings", () => {
  expect(normalizeRobotAvatarShape(" CLOUD ")).toBe("chip");
  expect(normalizeRobotAvatarShape("hexagon")).toBe("hex-visor");
  for (const value of [undefined, null, "", "unknown", "__proto__", "constructor"]) {
    expect(normalizeRobotAvatarShape(value)).toBe("chip");
  }
});
