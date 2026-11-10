import { flushSync } from "react-dom";
import { settleTransition } from "./setup/settle-transition";

/**
 * How long the app holds on its main page, with the new bot's row lit, before its chat
 * opens (the first bot's landing; see App.tsx and "Landing" in setup/setup.css).
 */
export const LANDING_HOLD_MS = 700;

/**
 * Runs one step of setup handing over to the app as a view transition. `tag` runs once the
 * new state is rendered, before it is captured, to name what the transition should move.
 * Without the API it is a plain update.
 */
export function landingStep(
  phase: "arrive" | "open",
  update: () => void,
  tag?: () => void
): Promise<void> {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== "function") {
    update();
    tag?.();
    return Promise.resolve();
  }
  root.dataset.landing = phase;
  const transition = document.startViewTransition(() => {
    flushSync(update);
    tag?.();
  });
  settleTransition(transition);
  return transition.finished
    .catch(() => {})
    .finally(() => {
      if (root.dataset.landing === phase) delete root.dataset.landing;
    });
}

/**
 * Names the new bot's sidebar row as where the preview's picture and name land, and lights
 * it; returns a function that removes the names once the flight is over (the light stays
 * until the chat opens).
 */
export function markLandingRow(channelId: string): () => void {
  const id = CSS.escape(channelId);
  const row =
    document.querySelector<HTMLElement>(`[data-channel-id="${id}"]`) ??
    document.querySelector<HTMLElement>(`[data-compact-channel-id="${id}"]`);
  if (!row) return () => {};
  row.dataset.landingRow = "";
  const avatar = row.querySelector<HTMLElement>("button > span:first-child") ?? null;
  const name = row.querySelector<HTMLElement>("span.truncate");
  if (avatar) avatar.style.viewTransitionName = "landing-avatar";
  if (name) name.style.viewTransitionName = "landing-name";
  return () => {
    if (avatar) avatar.style.viewTransitionName = "";
    if (name) name.style.viewTransitionName = "";
  };
}

/** Takes the light off the new bot's row. */
export function clearLandingRow() {
  for (const row of document.querySelectorAll<HTMLElement>("[data-landing-row]")) {
    delete row.dataset.landingRow;
  }
}
