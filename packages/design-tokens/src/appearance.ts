export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type NativeThemePreference = ResolvedTheme | "unspecified";

export const normalizeThemePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" || value === "system" ? value : "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemPrefersDark: boolean
): ResolvedTheme => (preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference);

export const nativeThemePreference = (
  preference: ThemePreference
): NativeThemePreference => (preference === "system" ? "unspecified" : preference);
