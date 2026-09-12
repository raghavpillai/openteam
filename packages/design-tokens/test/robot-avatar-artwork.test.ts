import { expect, test } from "bun:test";
import { ROBOT_AVATAR_SHAPES } from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_ARTWORK,
  type RobotAvatarNode,
  robotAvatarFaceColor,
} from "../src/robot-avatar-artwork";

test("every robot has serializable renderer-neutral vector artwork", () => {
  expect(Object.keys(ROBOT_AVATAR_ARTWORK)).toEqual([...ROBOT_AVATAR_SHAPES]);
  const inspect = (node: RobotAvatarNode) => {
    expect(["g", "rect", "circle", "line", "polygon"]).toContain(node.tag);
    expect(node.attributes).not.toHaveProperty("children");
    node.children?.forEach(inspect);
  };
  for (const nodes of Object.values(ROBOT_AVATAR_ARTWORK)) {
    expect(nodes.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes);
    nodes.forEach(inspect);
  }
});

test("black avatars keep contrasting faces across renderers", () => {
  expect(robotAvatarFaceColor("#242424")).toBe("#f2f2f2");
  expect(robotAvatarFaceColor("#925df2")).toBe("#1b1b1d");
});
