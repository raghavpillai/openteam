/** Damped springs, solved in closed form so any frame can be sampled directly. */
export interface Spring {
  /** Position at `t` seconds, from 0 to rest at 1. */
  at(t: number): number;
  /** Velocity at `t` seconds, in progress units per second. */
  velocity(t: number): number;
  /** Seconds until the motion is visually at rest. */
  duration: number;
}

export const spring = (stiffness: number, damping: number, mass = 1): Spring => {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return {
      at: (t) => 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t)),
      velocity: (t) => Math.exp(-zeta * omega * t) * ((omega * omega) / damped) * Math.sin(damped * t),
      duration: Math.log(1_000) / (zeta * omega),
    };
  }
  return {
    at: (t) => 1 - Math.exp(-omega * t) * (1 + omega * t),
    velocity: (t) => omega * omega * t * Math.exp(-omega * t),
    duration: 9.2 / omega,
  };
};

export const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** 0 before `start`, 1 after `end`, linear between: for staging one timeline. */
export const window01 = (value: number, start: number, end: number) => clamp((value - start) / (end - start), 0, 1);
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInCubic = (t: number) => t * t * t;
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

export interface Rect { x: number; y: number; width: number; height: number }

export const lerpRect = (from: Rect, to: Rect, amount: number): Rect => ({
  x: lerp(from.x, to.x, amount),
  y: lerp(from.y, to.y, amount),
  width: lerp(from.width, to.width, amount),
  height: lerp(from.height, to.height, amount),
});

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs `frame` on every display frame for `durationMs`, with the elapsed milliseconds.
 * Every moving piece of a scene reads the same clock, so they stay in step. Resolves
 * false if `signal` aborts first.
 */
export const timeline = (
  durationMs: number,
  frame: (elapsedMs: number) => void,
  signal?: AbortSignal
): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const start = performance.now();
    let handle = 0;
    const abort = () => {
      cancelAnimationFrame(handle);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const tick = (now: number) => {
      const elapsed = Math.min(durationMs, now - start);
      frame(elapsed);
      if (elapsed >= durationMs) {
        signal?.removeEventListener("abort", abort);
        resolve(true);
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
  });

/** Hermite smoothstep: starts and ends at rest, so fades never begin or stop abruptly. */
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Approaches the limits asymptotically instead of hitting them, so a clamp never snaps. */
export const softClamp = (value: number, min: number, max: number) =>
  value >= 0 ? max * Math.tanh(value / max) : -min * Math.tanh(value / -min);

/** Frame-rate independent low-pass: moves `current` toward `target` at `rate` per second. */
export const follow = (current: number, target: number, rate: number, dtMs: number) =>
  current + (target - current) * (1 - Math.exp((-rate * Math.max(0, dtMs)) / 1_000));
