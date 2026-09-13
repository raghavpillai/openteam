import { describe, expect, test } from "bun:test";
import {
  BOT_AVATAR_DEALT_COLORS,
  DEFAULT_BOT_AVATAR,
  botAvatarColorForKey,
  botAvatarShapeForKey,
  hashBotAvatarKey,
  resolveBotAvatarMark,
} from "../src";
import { ROBOT_AVATAR_SHAPES, normalizeRobotAvatarShape } from "../src/robot-avatar";

describe("bot avatar dealing", () => {
  test("keeps stable output vectors", () => {
    expect(resolveBotAvatarMark({ agentId: "00000000-0000-0000-0000-000000000000" })).toEqual({
      shape: "hex-visor",
      color: "#878787",
    });
    expect(resolveBotAvatarMark({ agentId: "123e4567-e89b-12d3-a456-426614174000" })).toEqual({
      shape: "helmet",
      color: "#ff9e12",
    });
    expect(resolveBotAvatarMark({ agentId: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).toEqual({
      shape: "goggles",
      color: "#ff9e12",
    });
  });

  test("uses unsigned 32-bit FNV-1a", () => {
    expect(hashBotAvatarKey("bot-example")).toBe(1_677_219_901);
  });

  test("deals every shape and non-black color without leaving the fixed sets", () => {
    const shapes = new Set<string>();
    const colors = new Set<string>();

    for (let index = 0; index < 2_048; index += 1) {
      const key = `bot-${index}`;
      shapes.add(botAvatarShapeForKey(key));
      colors.add(botAvatarColorForKey(key));
    }

    expect(shapes).toEqual(new Set(ROBOT_AVATAR_SHAPES));
    expect(colors).toEqual(new Set(BOT_AVATAR_DEALT_COLORS));
    expect(colors.has("#242424")).toBe(false);
  });

  test("preserves known explicit fields and hashes missing or unknown fields", () => {
    const agentId = "bot-example";

    expect(
      resolveBotAvatarMark({
        agentId,
        avatarShape: " CHIP ",
        avatarColor: "#F23D52",
      })
    ).toEqual({ shape: "chip", color: "#f23d52" });

    expect(resolveBotAvatarMark({ agentId, avatarShape: "chip" })).toEqual({
      shape: "chip",
      color: botAvatarColorForKey(agentId),
    });
    expect(resolveBotAvatarMark({ agentId, avatarColor: "#f23d52" })).toEqual({
      shape: botAvatarShapeForKey(agentId),
      color: "#f23d52",
    });

    expect(
      resolveBotAvatarMark({
        agentId,
        avatarShape: "legacy-symbol",
        avatarColor: "#123456",
      })
    ).toEqual({
      shape: botAvatarShapeForKey(agentId),
      color: botAvatarColorForKey(agentId),
    });
  });

  test("preserves every picker choice when resolving a saved bot profile", () => {
    for (const shape of ROBOT_AVATAR_SHAPES) {
      expect(resolveBotAvatarMark({ agentId: "bot-example", avatarShape: shape }).shape).toBe(
        shape
      );
    }
    expect(normalizeRobotAvatarShape()).toBe(DEFAULT_BOT_AVATAR.shape);
    expect(DEFAULT_BOT_AVATAR.icon).toBe(DEFAULT_BOT_AVATAR.shape);
  });

  test("treats retired silhouette names as unknown when resolving profiles", () => {
    const agentId = "bot-example";
    for (const avatarShape of [
      "circle",
      "blob",
      "square",
      "pill",
      "triangle",
      "hexagon",
      "cloud",
      "drop",
    ]) {
      expect(resolveBotAvatarMark({ agentId, avatarShape }).shape).toBe(
        botAvatarShapeForKey(agentId)
      );
    }
  });
});
