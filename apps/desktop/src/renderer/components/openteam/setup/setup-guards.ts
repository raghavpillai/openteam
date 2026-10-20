/** How long a new screen ignores submits, so one double press can't also answer the next screen. */
export const SETTLE_MS = 400;

/**
 * True for a submit that arrives while a screen has only just appeared and nothing on it was
 * touched: the second half of a double Enter. Typing, pasting or pressing on the screen first
 * counts as a deliberate answer.
 */
export const ignoresSubmit = (shownAt: number, now: number, touched: boolean): boolean =>
  !touched && now - shownAt < SETTLE_MS;

type KeyTarget = { readonly isConnected: boolean; closest(selectors: string): unknown } | null;

/**
 * What a key press that reached the window means for the setup screen. Menus and fields get
 * their keys first: a menu that closed on this key has already used it (its option is detached
 * by now), Enter in a field submits through the form itself, and a disabled primary button
 * means there is nothing to submit yet.
 */
export function setupKeyAction(
  key: string,
  target: KeyTarget,
  {
    repeat = false,
    menuOpen = false,
    submitDisabled = false,
  }: { repeat?: boolean; menuOpen?: boolean; submitDisabled?: boolean } = {}
): "back" | "submit" | null {
  if (menuOpen) return null;
  if (target && (!target.isConnected || target.closest("[role='option'], [role='listbox']"))) {
    return null;
  }
  if (key === "Escape") return "back";
  if (key !== "Enter" || repeat || submitDisabled) return null;
  if (target?.closest("input, textarea, button, select, a")) return null;
  return "submit";
}

/**
 * Which option row an arrow key moves to: the next or previous one, wrapping around, or the
 * first (or last) when none has focus yet. Null for other keys or when there are no rows.
 */
export function nextOptionIndex(key: string, current: number, count: number): number | null {
  if (count === 0 || (key !== "ArrowDown" && key !== "ArrowUp")) return null;
  const step = key === "ArrowDown" ? 1 : -1;
  if (current < 0) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}
