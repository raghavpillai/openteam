import { expect, test } from "bun:test";
import { ROBOT_AVATAR_SHAPES } from "@openteam/contracts/robot-avatar";
import { notificationAvatarSvg } from "../src/renderer/lib/notification-avatar";

test("notification icons use each profile shape and its selected color safely", () => {
  const icons = ROBOT_AVATAR_SHAPES.map((icon) =>
    notificationAvatarSvg({ name: "Probe", icon, color: "#fa00bb" })
  );
  expect(new Set(icons).size).toBe(ROBOT_AVATAR_SHAPES.length);
  for (const svg of icons) {
    expect(svg).toContain("#fa00bb");
    expect(svg).not.toContain("currentColor");
    expect(svg).not.toContain("var(");
    expect(svg).not.toContain("perspective");
  }
  expect(
    notificationAvatarSvg({ name: "Probe", icon: "bad", color: 'red" onload="bad' })
  ).toContain("#4f7cff");
  expect(notificationAvatarSvg({ name: "Probe", icon: "chip", color: "#242424" })).toContain(
    "#f2f2f2"
  );
});
