import { initializeTheme, normalizeThemePreference } from "../lib/theme";

let dispose: (() => void) | null = null;

/** Follow the app's appearance setting, which arrives with the Bot list: the overlay keeps
 * its own storage (it can't read or change the chat window's). */
export const refreshAppshotTheme = (preference?: string) => {
  dispose?.();
  dispose = initializeTheme(normalizeThemePreference(preference ?? "system"));
};
