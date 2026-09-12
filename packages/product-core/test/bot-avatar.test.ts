import { describe, expect, test } from "bun:test";
import { resolveBotAvatarMode } from "../src/bot-avatar";

const activeChannel = { id: "group", members: [{ botId: "one" }, { botId: "two" }] };
const running = { botId: "one", status: "running" } as const;

describe("shared bot avatar activity", () => {
  test("tracks the running bot, not every bot in the active group", () => {
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "one" })).toBe("thinking");
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "two" })).toBe("idle");
  });
  test("keeps another conversation or an unrelated bot still", () => {
    expect(
      resolveBotAvatarMode({ activeChannel, run: running, botId: "one", channelId: "other" })
    ).toBe("still");
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "unknown" })).toBe("still");
    expect(resolveBotAvatarMode({ run: running, botId: "one" })).toBe("still");
  });
  test("leaves thinking after a terminal or approval state", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "waiting_approval",
    ] as const) {
      expect(
        resolveBotAvatarMode({ activeChannel, run: { ...running, status }, botId: "one" })
      ).toBe("idle");
    }
    expect(resolveBotAvatarMode({ activeChannel, botId: "one" })).toBe("idle");
  });
});
