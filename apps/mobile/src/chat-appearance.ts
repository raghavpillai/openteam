import { darkTheme, lightTheme, useTheme } from "./theme";

// Sampled from the supplied sRGB chat references. Alpha labels adapt to the
// backdrop: the same tertiary label is dimmer on the timeline than on glass.
const darkChatTheme = {
  ...darkTheme,
  text: "#FFFFFF",
  textMuted: "rgba(235,235,245,0.6)",
  textFaint: "rgba(235,235,245,0.3)",
} as const;

export function useChatTheme() {
  return useTheme().dark ? darkChatTheme : lightTheme;
}

export const chatGlassTint = "rgba(255,255,255,0.056)";
