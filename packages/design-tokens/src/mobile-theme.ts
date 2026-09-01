/** Semantic values shared by native clients; components consume roles, not raw colors. */
export const mobileLightTheme = {
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

export const mobileDarkTheme = {
  dark: true,
  background: "#141414",
  surface: "#242422",
  surfaceElevated: "#202020",
  field: "#343434",
  surfacePressed: "#2C2C30",
  text: "#F7F7F4",
  textMuted: "#969691",
  textFaint: "#6F6F6B",
  border: "rgba(255,255,255,0.14)",
  separator: "rgba(255,255,255,0.09)",
  userBubble: "#5C5C5C",
  userText: "#FFFFFF",
  assistantBubble: "#202020",
  accent: "#4D9BFF",
  success: "#20C997",
  danger: "#FF6369",
  reaction: "#0C376B",
  reactionText: "#FFFFFF",
} as const;

export type MobileTheme = typeof mobileLightTheme | typeof mobileDarkTheme;

export const mobileMetrics = {
  pageGutter: 18,
  rowGap: 14,
  radiusSmall: 12,
  radiusMedium: 18,
  radiusLarge: 26,
  hitTarget: 44,
  composerMinHeight: 44,
  composerMaxHeight: 214,
} as const;
