/**
 * Damped-spring easings rendered as CSS `linear()` curves, so CSS transitions
 * and Web Animations share one physical feel. The values match the springs
 * declared at the top of presentation.css; regenerate both together.
 */
export type Spring = { easing: string; duration: number; at: (t: number) => number };

export function spring(stiffness: number, damping: number, mass = 1): Spring {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const position = (t: number) => {
    if (zeta < 1) {
      const damped = omega * Math.sqrt(1 - zeta * zeta);
      return (
        1 -
        Math.exp(-zeta * omega * t) *
          (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t))
      );
    }
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  };
  let settle = 0;
  for (let t = 0; t < 3; t += 1 / 240) if (Math.abs(1 - position(t)) > 0.0015) settle = t;
  const duration = Math.ceil(settle * 1000);
  const count = Math.min(64, Math.max(24, Math.round(duration / 12)));
  const stops = Array.from({ length: count + 1 }, (_, i) =>
    i === count ? "1" : String(Math.round(position((settle * i) / count) * 10000) / 10000)
  );
  return { easing: `linear(${stops.join(", ")})`, duration, at: (t: number) => position(t * settle) };
}

// Snappy first, gooey second. Boxes and positions move on near-critical
// springs (no edge ever overshoots its container); the goo is a small,
// separate scale bump on the moving surface. Direct feedback is ~120–150 ms.
/** Container boxes (left/top/width/height): 95% in ~155 ms, no overshoot. */
export const frameSpring = spring(700, 48);
/** The jelly bump layered on a morphing surface: ~6% overshoot. */
export const morphSpring = spring(520, 30);
/** Shared photo and title following the box. */
export const trailSpring = spring(640, 44);
/** Closing back into a card or pin: no overshoot, ~330 ms tail. */
export const settleSpring = spring(620, 44);
/** Content entering after the box. */
export const softSpring = spring(600, 46);
/** Switching places and other instant swaps: 95% in ~140 ms. */
export const snapSpring = spring(800, 50);

/**
 * The carousel is a mass on a spring: velocity carries into the snap, and
 * the snap overshoots a little before resting on the card.
 */
export const carouselSpring = { stiffness: 600, damping: 42 };

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
