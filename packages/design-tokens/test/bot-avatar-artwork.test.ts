import { expect, test } from "bun:test";
import { BOT_AVATAR_SHAPES } from "@openteam/contracts/bot-avatar";
import {
  BOT_AVATAR_ARTWORK,
  BOT_AVATAR_NATIVE_ARTWORK,
  botAvatarEyeRects,
  botAvatarEyeTransform,
} from "../src";

test("every public Bot shape has renderer-neutral artwork", () => {
  expect(Object.keys(BOT_AVATAR_ARTWORK).sort()).toEqual([...BOT_AVATAR_SHAPES].sort());
  expect(Object.keys(BOT_AVATAR_NATIVE_ARTWORK).sort()).toEqual([...BOT_AVATAR_SHAPES].sort());
  for (const shape of BOT_AVATAR_SHAPES) {
    expect(BOT_AVATAR_ARTWORK[shape].eyes.left).toHaveLength(2);
    expect(BOT_AVATAR_NATIVE_ARTWORK[shape].length).toBeGreaterThan(0);
  }
});

test("both renderers receive identical resolved eye geometry", () => {
  const [left, right] = botAvatarEyeRects(BOT_AVATAR_ARTWORK.circle.eyes);
  expect(left).toEqual({
    height: 6.4,
    rotation: -16,
    rx: 1.875,
    width: 3.75,
    x: 19.175,
    y: 13.1,
  });
  expect(right.rotation).toBe(-16);
  expect(right.rx).toBe(1.45);
  expect(botAvatarEyeTransform(left)).toBe("rotate(-16 21.05 16.3)");
});
