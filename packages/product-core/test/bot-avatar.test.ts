import { describe, expect, test } from "bun:test";
import { resolveBotAvatarMode } from "../src/bot-avatar";

const activeChannel = { id: "group", members: [{ botId: "one" }, { botId: "two" }] };
const running = { botId: "one", status: "running" } as const;

describe("shared bot avatar activity", () => {
  test("tracks the running bot, not every bot in the active group", () => {
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "one" })).toBe("thinking");
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "two" })).toBe("idle");
  });
  test("idles other conversations without leaking the open chat's activity", () => {
    expect(
      resolveBotAvatarMode({ activeChannel, run: running, botId: "one", channelId: "other" })
    ).toBe("idle");
    expect(resolveBotAvatarMode({ activeChannel, run: running, botId: "unknown" })).toBe("still");
    expect(resolveBotAvatarMode({ run: running, botId: "one" })).toBe("still");
  });
  test("tracks every working member in background chats independently", () => {
    const runsByChannel = new Map([
      ["background", [running, { botId: "two", status: "queued" } as const]],
      ["resting", [{ ...running, status: "completed" } as const]],
    ]);
    for (const botId of ["one", "two"]) {
      expect(resolveBotAvatarMode({ activeChannel, runsByChannel, botId, channelId: "background" }))
        .toBe("thinking");
    }
    expect(resolveBotAvatarMode({ activeChannel, runsByChannel, botId: "three", channelId: "background" }))
      .toBe("idle");
    expect(resolveBotAvatarMode({ activeChannel, runsByChannel, botId: "one", channelId: "resting" }))
      .toBe("idle");
    expect(resolveBotAvatarMode({ runsByChannel, botId: "one", channelId: "background" }))
      .toBe("thinking");
    runsByChannel.set("background", []);
    expect(resolveBotAvatarMode({ activeChannel, run: running, runsByChannel, botId: "one", channelId: "background" }))
      .toBe("idle");
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
