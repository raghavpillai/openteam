import * as NativeHaptics from "expo-haptics";
import { AppState } from "react-native";
import { hapticFeedbackAllowed, playHaptic } from "./haptics-core";
import { hapticPreferences } from "./haptic-preferences";

export const ImpactFeedbackStyle = NativeHaptics.ImpactFeedbackStyle;
export const NotificationFeedbackType = NativeHaptics.NotificationFeedbackType;

// Let iOS honor system haptic settings, Low Power Mode, camera, and dictation restrictions.
// Async operations that finish after leaving the app must not buzz in the background.
const active = () =>
  hapticFeedbackAllowed(hapticPreferences.getSnapshot().enabled, AppState.currentState);
export const selectionAsync = () => playHaptic(() => NativeHaptics.selectionAsync(), active());
export const impactAsync = (style?: NativeHaptics.ImpactFeedbackStyle) =>
  playHaptic(() => NativeHaptics.impactAsync(style), active());
export const notificationAsync = (type?: NativeHaptics.NotificationFeedbackType) =>
  playHaptic(() => NativeHaptics.notificationAsync(type), active());
