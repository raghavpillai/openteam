import {
  normalizeThemePreference,
  resolveTheme,
  type ThemePreference,
  type ResolvedTheme,
} from "@openbot/design-tokens/appearance";

export {
  normalizeThemePreference,
  resolveTheme,
  type ThemePreference,
  type ResolvedTheme,
} from "@openbot/design-tokens/appearance";

export const THEME_STORAGE_KEY = "openbot:theme";
export const THEME_CHANGE_EVENT = "openbot:theme-change";

export const readThemePreference = (): ThemePreference =>
  normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));

const syncDocumentTheme = (
  preference: ThemePreference,
  systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
): ResolvedTheme => {
  const resolved = resolveTheme(preference, systemPrefersDark);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
  return resolved;
};

export const setThemePreference = (preference: ThemePreference): void => {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  syncDocumentTheme(preference);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { preference } }));
};

export const initializeTheme = (): (() => void) => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => syncDocumentTheme(readThemePreference(), media.matches);
  sync();
  media.addEventListener("change", sync);
  return () => media.removeEventListener("change", sync);
};
