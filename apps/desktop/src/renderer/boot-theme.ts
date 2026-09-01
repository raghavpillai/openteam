import { normalizeThemePreference, resolveTheme } from "@openbot/design-tokens/appearance";

const preference = (() => {
  try {
    return normalizeThemePreference(localStorage.getItem("openbot:theme"));
  } catch {
    return "system";
  }
})();
const resolved = resolveTheme(
  preference,
  window.matchMedia("(prefers-color-scheme: dark)").matches
);
document.documentElement.dataset.theme = resolved;
document.documentElement.dataset.themePreference = preference;
document.documentElement.style.colorScheme = resolved;
