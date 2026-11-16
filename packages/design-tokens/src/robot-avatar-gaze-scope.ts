/**
 * Where an avatar looks. hover: toward the pointer while it is over the avatar's row, and only
 * while the Bot is idle. follow: toward the pointer anywhere in the window, busy or not.
 * emphasis: no gaze, but the eyes open wide while hovered. off: never.
 */
export type RobotAvatarGaze = "hover" | "follow" | "emphasis" | "off";

/** The row, button or card an avatar belongs to; hovering it wakes the avatar's gaze. */
export function robotAvatarGazeScope(svg: SVGSVGElement): Element {
  return (
    svg.closest("[data-avatar-gaze-scope]") ??
    svg.closest('button, a[href], [role="button"], [role="option"]') ??
    svg
  );
}

type GazeModule = typeof import("./robot-avatar-gaze");
let loaded: GazeModule | null = null;
let loading: Promise<GazeModule> | null = null;
/** Pointer gaze, pokes and idle life load on the first hover or press, or once the app is idle. */
export const loadRobotAvatarGaze = (): Promise<GazeModule> =>
  (loading ??= import("./robot-avatar-gaze").then(
    (module) => (loaded = module),
    (error: unknown) => {
      // Let the next hover try again.
      loading = null;
      throw error;
    }
  ));
export const loadedRobotAvatarGaze = () => loaded;

let whenIdle: Promise<GazeModule> | null = null;
/**
 * Idle fidgets and neighbours glancing at each other need the module before anyone points
 * at an avatar, so it also loads once the app has settled after startup.
 */
export const loadRobotAvatarGazeWhenIdle = (): Promise<GazeModule> =>
  (whenIdle ??= new Promise<void>((resolve) => {
    window.setTimeout(() => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
      else resolve();
    }, 2_500);
  }).then(loadRobotAvatarGaze));
