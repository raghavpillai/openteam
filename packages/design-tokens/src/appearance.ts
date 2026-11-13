export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const normalizeThemePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" || value === "system" ? value : "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemPrefersDark: boolean
): ResolvedTheme => (preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference);
