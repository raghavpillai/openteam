import { describe, expect, test } from "bun:test";
import {
  BOT_AVATAR_DEALT_COLORS,
  BOT_AVATAR_SHAPES,
  botAvatarColorForKey,
  botAvatarShapeForKey,
  hashBotAvatarKey,
  resolveBotAvatarMark,
} from "../src";

describe("bot avatar dealing", () => {
  test("keeps stable output vectors", () => {
    expect(resolveBotAvatarMark({ agentId: "00000000-0000-0000-0000-000000000000" })).toEqual({
      shape: "blob",
      color: "#878787",
    });
    expect(resolveBotAvatarMark({ agentId: "123e4567-e89b-12d3-a456-426614174000" })).toEqual({
      shape: "pill",
      color: "#ff9e12",
    });
    expect(resolveBotAvatarMark({ agentId: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).toEqual({
      shape: "hexagon",
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

    expect(shapes).toEqual(new Set(BOT_AVATAR_SHAPES));
    expect(colors).toEqual(new Set(BOT_AVATAR_DEALT_COLORS));
    expect(colors.has("#242424")).toBe(false);
  });

  test("preserves known explicit fields and hashes missing or unknown fields", () => {
    const agentId = "bot-example";

    expect(
      resolveBotAvatarMark({
        agentId,
        avatarShape: " CLOUD ",
        avatarColor: "#F23D52",
      })
    ).toEqual({ shape: "cloud", color: "#f23d52" });

    expect(resolveBotAvatarMark({ agentId, avatarShape: "cloud" })).toEqual({
      shape: "cloud",
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
});
