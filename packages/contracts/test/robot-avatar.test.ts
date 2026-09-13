import { expect, test } from "bun:test";
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
});

test("normalization accepts current names and safely defaults unknown stored strings", () => {
  expect(normalizeRobotAvatarShape(" CHIP ")).toBe("chip");
  expect(normalizeRobotAvatarShape(" HEX-VISOR ")).toBe("hex-visor");
  for (const value of [undefined, null, "", "unknown", "__proto__", "constructor"]) {
    expect(normalizeRobotAvatarShape(value)).toBe("chip");
  }
});

test("retired silhouette names use the default without identity mappings", () => {
  for (const value of [
    "circle",
    "blob",
    "square",
    "pill",
    "triangle",
    "hexagon",
    "cloud",
    "drop",
  ]) {
    expect(normalizeRobotAvatarShape(value)).toBe("chip");
  }
});
