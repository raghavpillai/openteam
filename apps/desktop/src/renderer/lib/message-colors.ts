import type { CSSProperties } from "react";
import { botMessagePalette } from "@openteam/design-tokens/message-colors";

export const BOT_MESSAGE_COLORS_KEY = "openteam:bot-message-colors";
const CHANGE_EVENT = "openteam:bot-message-colors-change";

export const readBotMessageColors = (): boolean => {
  try {
    return localStorage.getItem(BOT_MESSAGE_COLORS_KEY) === "true";
  } catch {
    return false;
  }
};

export const setBotMessageColors = (enabled: boolean): void => {
  localStorage.setItem(BOT_MESSAGE_COLORS_KEY, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const subscribeBotMessageColors = (listener: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === BOT_MESSAGE_COLORS_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
};

export function botMessageColorStyle(
  enabled: boolean,
  color?: string,
  hasAvatar = false
): CSSProperties | undefined {
  const palette = enabled && !hasAvatar ? botMessagePalette(color) : null;
  if (!palette) return undefined;
  return {
    "--bot-message-user-light": palette.light,
    "--bot-message-user-dark": palette.dark,
  } as CSSProperties;
}
