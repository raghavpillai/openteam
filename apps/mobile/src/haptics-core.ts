export const hapticFeedbackAllowed = (enabled: boolean, appState: string | null): boolean =>
  enabled && appState === "active";

/** Haptics are supplemental feedback; native failures must never fail the user's action. */
export async function playHaptic(effect: () => Promise<void>, active: boolean): Promise<void> {
  if (!active) return;
  try {
    await effect();
  } catch {
    // Unsupported hardware and temporary native-engine failures are silent fallbacks.
  }
}
