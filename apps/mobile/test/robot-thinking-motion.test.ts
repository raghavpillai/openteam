import { expect, test } from "bun:test";
import {
  ROBOT_AVATAR_ARTWORK,
  type RobotAvatarNode,
} from "@openteam/design-tokens/robot-avatar-artwork";
import { robotNodeCenter, robotThinkingPose } from "../src/robot-thinking-motion";

const pose = (part: string, time: number) => robotThinkingPose(part, time, 6400, 4, 0, [50, 50]);

test("thinking eyes look both ways, blink and return to their rest pose", () => {
  expect(pose("eyes", 640).matrix[4]).toBeCloseTo(3);
  expect(pose("eyes", 3200).matrix[4]).toBeCloseTo(-3);
  expect(pose("eyes", 4864).matrix[3]).toBeCloseTo(0.08);
  expect(pose("eyes", 6400).matrix[3]).toBeCloseTo(1);
  expect(pose("eyes", 6400).matrix[4]).toBeCloseTo(0);
});

test("body, visor and status lights loop at their original animation periods", () => {
  expect(pose("body", 4200)).toEqual(pose("body", 0));
  expect(pose("body", 2100).matrix).not.toEqual(pose("body", 0).matrix);
  expect(pose("visor", 0).matrix[4]).toBeCloseTo(-17);
  expect(pose("visor", 1300).matrix[4]).toBeCloseTo(17);
  expect(pose("cursor", 0).opacity).toBe(0.7);
  expect(pose("cursor", 550).opacity).toBe(0);
});

test("every shared robot part has a valid center and bounded native animation", () => {
  const visit = (node: RobotAvatarNode, index: number) => {
    const center = robotNodeCenter(node);
    expect(center.every(Number.isFinite)).toBe(true);
    const part = node.attributes["data-p"];
    if (typeof part === "string") {
      for (const time of [0, 600, 1400, 5000, 10000]) {
        const result = robotThinkingPose(
          part,
          time,
          6400,
          Number(node.attributes["data-lim"] ?? 0),
          index,
          center
        );
        expect(result.matrix.every(Number.isFinite)).toBe(true);
        expect(result.opacity).toBeGreaterThanOrEqual(0);
        expect(result.opacity).toBeLessThanOrEqual(1);
      }
    }
    node.children?.forEach(visit);
  };
  for (const artwork of Object.values(ROBOT_AVATAR_ARTWORK)) artwork.forEach(visit);
});
