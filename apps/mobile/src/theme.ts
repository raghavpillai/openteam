import { useColorScheme } from "react-native";

export const lightTheme = {
  dark: false,
  background: "#FFFFFF",
  surface: "#F3F3F1",
  surfaceElevated: "#FFFFFF",
  field: "#FCFCFB",
  surfacePressed: "#EAEAE7",
  text: "#111111",
  textMuted: "#767672",
  textFaint: "#A6A6A0",
  border: "rgba(17,17,17,0.12)",
  separator: "rgba(17,17,17,0.08)",
  userBubble: "#0A0A0A",
  userText: "#FFFFFF",
  assistantBubble: "#F1F1EF",
  accent: "#1677FF",
  success: "#13A37B",
  danger: "#E5484D",
  reaction: "#DCEBFF",
  reactionText: "#111111",
} as const;

export const darkTheme = {
  dark: true,
  background: "#050505",
  surface: "#242422",
  surfaceElevated: "#171716",
  field: "#2E2E2C",
  surfacePressed: "#343432",
  text: "#F7F7F4",
  textMuted: "#969691",
  textFaint: "#6F6F6B",
  border: "rgba(255,255,255,0.14)",
  separator: "rgba(255,255,255,0.09)",
  userBubble: "#646462",
  userText: "#FFFFFF",
  assistantBubble: "#272725",
  accent: "#4D9BFF",
  success: "#20C997",
  danger: "#FF6369",
  reaction: "#0C376B",
  reactionText: "#FFFFFF",
} as const;

export type Theme = typeof lightTheme | typeof darkTheme;

export const useTheme = (): Theme => (useColorScheme() === "dark" ? darkTheme : lightTheme);

export const metrics = {
  pageGutter: 18,
  rowGap: 14,
  radiusSmall: 12,
  radiusMedium: 18,
  radiusLarge: 26,
  hitTarget: 44,
  composerMinHeight: 44,
  composerMaxHeight: 214,
} as const;
