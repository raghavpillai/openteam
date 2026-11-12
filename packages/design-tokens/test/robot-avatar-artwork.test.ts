import { expect, test } from "bun:test";
import {
  robotAvatarFaceColor,
} from "../src/robot-avatar-artwork";

test("black avatars keep contrasting faces across renderers", () => {
  expect(robotAvatarFaceColor("#242424")).toBe("#f2f2f2");
  expect(robotAvatarFaceColor("#925df2")).toBe("#1b1b1d");
});
