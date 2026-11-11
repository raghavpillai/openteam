import { expect, test } from "bun:test";
import { BOT_AVATAR_COLORS } from "@openteam/contracts/bot-avatar";
import { botMessagePalette } from "@openteam/design-tokens/message-colors";
import { botMessageColorStyle } from "../src/renderer/lib/message-colors";

test("disabled, custom-picture, black/gray and invalid bots retain neutral colors", () => {
  expect(botMessageColorStyle(false, "#ff9e12")).toBeUndefined();
  expect(botMessageColorStyle(true, "#ff9e12", true)).toBeUndefined();
  for (const color of [undefined, "#242424", "#878787", "red; background: blue"])
    expect(botMessageColorStyle(true, color)).toBeUndefined();
});

test("picker colors resolve to the measured Grok Bot theme pairs", () => {
  const measured = [
    ["#a47952", "#86592e", "#8c5d31"],
    ["#f23d52", "#c82532", "#cf2b35"],
    ["#ff7a1a", "#d2550a", "#cd5309"],
    ["#ff9e12", "#c2730b", "#c8770c"],
    ["#10b972", "#0d9655", "#0e9f5a"],
    ["#27baae", "#0d9381", "#0e9886"],
    ["#4b8efb", "#126fd4", "#116dd2"],
    ["#925df2", "#7442d1", "#7845d7"],
    ["#ef479b", "#c82779", "#cf297e"],
  ] as const;
  for (const [avatar, light, dark] of measured)
    expect(botMessagePalette(avatar)).toMatchObject({ light, dark });
  expect(botMessagePalette("#4B8EFB")).toEqual(botMessagePalette("#4b8efb"));
  expect(botMessagePalette("violet")).toMatchObject({ light: "#7442d1", dark: "#7845d7" });
  // Legacy colors stay in the nearest picker family instead of losing their tint.
  expect(botMessagePalette("#ff7b1a")).toEqual(botMessagePalette("#ff7a1a"));
  for (const color of BOT_AVATAR_COLORS.slice(1, -1)) {
    const style = botMessageColorStyle(true, color) as Record<string, string>;
    expect(style["--bot-message-user-light"]).toMatch(/^#[\da-f]{6}$/);
    expect(style["--bot-message-user-dark"]).toMatch(/^#[\da-f]{6}$/);
    expect(style["--message-user-foreground"]).toBeUndefined();
  }
});
