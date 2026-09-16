// The artwork keeps a 32-point layout box with 16 points above and below it.
// Extra space here shifts the entire bottom-aligned conversation upward.
export const THINKING_SLOT_HEIGHT = 64;

/** 0 → 1 opens the empty slot; 1 → 2 reveals the robot. Reverse to dismiss. */
export function thinkingIndicatorPresence(phase: number) {
  "worklet";
  return {
    height: Math.max(0, Math.min(1, phase)) * THINKING_SLOT_HEIGHT,
    opacity: Math.max(0, Math.min(1, phase - 1)),
  };
}

export function thinkingIndicatorTransition(
  phase: number,
  visible: boolean,
  reduceMotion: boolean
) {
  const current = Math.max(0, Math.min(2, phase));
  const steps: { to: number; duration: number; curve: "space" | "enter" | "exit" }[] = [];
  if (visible) {
    if (current < 1)
      steps.push({ to: 1, duration: reduceMotion ? 0 : (1 - current) * 360, curve: "space" });
    if (current < 2)
      steps.push({ to: 2, duration: Math.min(1, 2 - current) * 180, curve: "enter" });
  } else {
    if (current > 1) steps.push({ to: 1, duration: (current - 1) * 240, curve: "exit" });
    if (current > 0)
      steps.push({
        to: 0,
        duration: reduceMotion ? 0 : Math.min(1, current) * 360,
        curve: "space",
      });
  }
  return steps;
}
