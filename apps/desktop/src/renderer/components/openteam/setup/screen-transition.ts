import { useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { settleTransition } from "./settle-transition";

// Renders that happen inside a view transition's update; see useEnterAnimation.
let updating = 0;
// Screens, titles and pictures that have appeared already, and when, so each entrance
// plays once. Something mounted again soon after it first appeared (the first-run frame's
// server check, handing over to the real one) picks its entrance up where it was instead
// of jumping to the end; see useEntranceResume.
const shown = new Map<string, number>();
const RESUME_MS = 1200;
const sinceShown = (key: string): number | null => {
  const at = shown.get(key);
  return at === undefined ? null : performance.now() - at;
};
const markShown = (key: string) => {
  if (!shown.has(key)) shown.set(key, performance.now());
};

/**
 * How something arrives, from how long ago it first appeared (null: never) and whether a
 * view transition is bringing it in: see useEnterAnimation and useEntranceResume.
 */
export function entrance(
  since: number | null,
  inTransition: boolean
): { mode: EnterMode; resumeAt: number } {
  if (inTransition) return { mode: "transition", resumeAt: 0 };
  if (since === null) return { mode: "enter", resumeAt: 0 };
  return since < RESUME_MS ? { mode: "enter", resumeAt: since } : { mode: null, resumeAt: 0 };
}

// Steps taken through setup, forward minus back. The stage's dots and lights drift by it
// (--setup-camera in setup.css), slower than the content: parallax.
let camera = 0;
const CAMERA_RANGE = 30;

/**
 * Changes setup screens as a view transition: the stage, its picture, the progress bar,
 * the title and the primary button carry over between screens (named in setup.css) while
 * the rest of the content recedes and settles by direction. Without the API it is a plain
 * update.
 */
export function changeScreen(update: () => void, direction: "forward" | "back" = "forward") {
  const root = document.documentElement;
  const moveCamera = () => {
    const step = direction === "back" ? -1 : 1;
    camera = Math.max(-CAMERA_RANGE, Math.min(CAMERA_RANGE, camera + step));
    root.style?.setProperty("--setup-camera", String(camera));
  };
  if (typeof document.startViewTransition !== "function") {
    update();
    moveCamera();
    return;
  }
  root.dataset.setupDirection = direction;
  // Set again during the update if the stage picture or look changes (see useVisualSwap
  // and useStageSwap).
  delete root.dataset.setupVisual;
  delete root.dataset.setupStage;
  const transition = document.startViewTransition(() => {
    updating += 1;
    try {
      flushSync(update);
    } finally {
      updating -= 1;
    }
    // After the old screen was captured, so the new stage drifts on from where it was.
    moveCamera();
  });
  settleTransition(transition);
  const cleanUp = () => {
    if (root.dataset.setupDirection !== direction) return;
    delete root.dataset.setupDirection;
    delete root.dataset.setupVisual;
    delete root.dataset.setupStage;
  };
  transition.finished.then(cleanUp, cleanUp);
}

/**
 * How the element keyed by `key` arrives: "enter" plays its own entrance (the first time it
 * appears), "transition" means a view transition is bringing it in, and null means it was
 * on screen before and simply stays. Decided once per key, so later renders never restart
 * or cut an animation.
 */
export type EnterMode = "enter" | "transition" | null;
export function useEnterAnimation(key: string): EnterMode {
  const state = useRef<{ key: string; mode: EnterMode } | null>(null);
  if (state.current?.key !== key) {
    state.current = { key, mode: entrance(sinceShown(key), updating > 0).mode };
  }
  useEffect(() => markShown(key), [key]);
  return state.current.mode;
}

/**
 * How far into its entrance something mounted again should start (ms), or 0: its first
 * appearance was moments ago, so the entrance carries on rather than replaying or ending.
 */
export function useEntranceResume(key: string): number {
  const state = useRef<{ key: string; at: number } | null>(null);
  if (state.current?.key !== key) {
    state.current = { key, at: entrance(sinceShown(key), updating > 0).resumeAt };
  }
  return state.current.at;
}

/** Whether something keyed by `key` has appeared before (it then skips its entrance). */
export function useAppearedBefore(key: string): boolean {
  const state = useRef<{ key: string; before: boolean } | null>(null);
  if (state.current?.key !== key) {
    state.current = { key, before: entrance(sinceShown(key), false).mode === null };
  }
  useEffect(() => markShown(key), [key]);
  return state.current.before;
}

// Whether the stage last showed its "It works!" look.
let celebrated: boolean | null = null;

/**
 * Tells the running view transition when the stage changes look (into or out of "It
 * works!"): the stage then cross-fades instead of carrying straight over.
 */
export function useStageSwap(celebrate: boolean) {
  // A layout effect, so it lands inside the transition's synchronous update.
  useLayoutEffect(() => {
    if (celebrated !== null && celebrated !== celebrate) {
      document.documentElement.dataset.setupStage = "swap";
    }
    celebrated = celebrate;
  }, [celebrate]);
}

// The stage picture shown last, so a screen change can keep a picture that stays.
let visualShown: string | null = null;

/**
 * Tells the running view transition whether the stage picture changes ("swap": the old one
 * fades out, then the new one in) or stays (it is kept and only what changed moves).
 */
export function useVisualSwap(key: string) {
  // A layout effect, so it lands inside the transition's synchronous update.
  useLayoutEffect(() => {
    if (visualShown !== null && visualShown !== key) {
      document.documentElement.dataset.setupVisual = "swap";
    }
    visualShown = key;
  }, [key]);
}
