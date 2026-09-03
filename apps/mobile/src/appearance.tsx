import {
  nativeThemePreference,
  normalizeThemePreference,
  resolveTheme,
  type ThemePreference,
} from "@openbot/design-tokens/appearance";
import * as SecureStore from "expo-secure-store";
import type React from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance, useColorScheme } from "react-native";

export type AppearancePreference = ThemePreference;
export type AccentPreference = "black" | "blue";

interface AppearanceState {
  preference: AppearancePreference;
  accent: AccentPreference;
  dark: boolean;
  setAccent: (accent: AccentPreference) => Promise<void>;
  setPreference: (preference: AppearancePreference) => Promise<void>;
}

const STORAGE_KEY = "openbot.appearance";
const ACCENT_STORAGE_KEY = "openbot.accent";
const AppearanceContext = createContext<AppearanceState | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const systemDark = useColorScheme() === "dark";
  const [preference, setPreferenceState] = useState<AppearancePreference>("system");
  const [accent, setAccentState] = useState<AccentPreference>("black");

  useEffect(() => {
    let active = true;
    void Promise.all([
      SecureStore.getItemAsync(STORAGE_KEY),
      SecureStore.getItemAsync(ACCENT_STORAGE_KEY),
    ]).then(([storedPreference, storedAccent]) => {
      if (!active) return;
      setPreferenceState(normalizeThemePreference(storedPreference));
      setAccentState(storedAccent === "blue" ? "blue" : "black");
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    Appearance.setColorScheme(nativeThemePreference(preference));
  }, [preference]);

  const value = useMemo<AppearanceState>(
    () => ({
      preference,
      accent,
      dark: resolveTheme(preference, systemDark) === "dark",
      setAccent: async (next) => {
        setAccentState(next);
        await SecureStore.setItemAsync(ACCENT_STORAGE_KEY, next);
      },
      setPreference: async (next) => {
        setPreferenceState(next);
        await SecureStore.setItemAsync(STORAGE_KEY, next);
      },
    }),
    [accent, preference, systemDark]
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export const useAppearance = (): AppearanceState => {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used inside AppearanceProvider");
  return value;
};
