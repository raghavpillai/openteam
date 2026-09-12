import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { createHapticPreferenceStore } from "./haptic-preference-store";

const STORAGE_KEY = "openteam.haptics";
export const hapticPreferences = createHapticPreferenceStore({
  read: () => SecureStore.getItemAsync(STORAGE_KEY),
  write: (value) => SecureStore.setItemAsync(STORAGE_KEY, value),
});

export const useHapticPreference = () =>
  useSyncExternalStore(hapticPreferences.subscribe, hapticPreferences.getSnapshot);
