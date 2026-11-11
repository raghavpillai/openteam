import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_COLOR_NAMES,
  resolveBotAvatarColorName,
} from "@openteam/contracts/bot-avatar";
import colors from "./message-colors.json";

/** Measured from Grok Bot 0.79.3's light/dark message tokens. */
export const BOT_MESSAGE_COLORS = colors;

export function botMessagePalette(color?: string): { light: string; dark: string } | null {
  const hex = resolveBotAvatarColorName(color?.trim().toLowerCase() ?? "");
  if (!/^#[\da-f]{6}$/i.test(hex)) return null;
  let nearest = 0,
    distance = Infinity;
  BOT_AVATAR_COLORS.forEach((candidate, index) => {
    const delta = [1, 3, 5].reduce(
      (sum, offset) =>
        sum +
        (parseInt(candidate.slice(offset, offset + 2), 16) -
          parseInt(hex.slice(offset, offset + 2), 16)) **
          2,
      0
    );
    if (delta < distance) {
      nearest = index;
      distance = delta;
    }
  });
  return colors.find((entry) => entry.name === BOT_AVATAR_COLOR_NAMES[nearest]) ?? null;
}
