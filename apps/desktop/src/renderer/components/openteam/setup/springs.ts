// Spring physics for setup's motion, as CSS `linear()` easings (see the "Springs" block at
// the top of the motion section in setup.css, which the tests keep in sync with this file).

/** A damped spring, described like SwiftUI's: `response` in seconds, `damping` as a fraction. */
export type Spring = { response: number; damping: number };

/** The presets setup uses, after SwiftUI's `.smooth`, `.snappy` and `.bouncy`. */
export const SPRINGS = {
  // Settles without overshoot: screen changes, pictures and anything large.
  smooth: { response: 0.5, damping: 1 },
  // Quick, with a hint of overshoot: controls, text and small pictures.
  snappy: { response: 0.35, damping: 0.85 },
  // A visible bounce: the robots landing, bubbles and checks popping.
  bouncy: { response: 0.5, damping: 0.62 },
  // Slow and soft: the first bot flying into the app.
  gentle: { response: 0.7, damping: 1 },
} as const satisfies Record<string, Spring>;

/** How far from rest the motion may be when it is considered settled (fraction of travel). */
const REST = 0.002;

/** Where a spring released from 0 towards 1 is after `t` seconds. */
export function springAt({ response, damping }: Spring, t: number): number {
  const omega = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const decay = damping * omega;
  const frequency = omega * Math.sqrt(1 - damping * damping);
  return (
    1 -
    Math.exp(-decay * t) * (Math.cos(frequency * t) + (decay / frequency) * Math.sin(frequency * t))
  );
}

/** How long the spring takes to stay within REST of where it ends (ms, rounded up to 10). */
export function springDuration(spring: Spring): number {
  const step = 0.001;
  let settled = 0;
  for (let t = 0; t < 4; t += step) {
    if (Math.abs(1 - springAt(spring, t)) > REST) settled = t + step;
  }
  return Math.ceil((settled * 1000) / 10) * 10;
}

// Keeps the fewest points that stay within `tolerance` of the curve (Ramer–Douglas–Peucker).
function simplify(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length <= 2) return points;
  const [x0, y0] = first;
  const [x1, y1] = last;
  let worst = 0;
  let index = 0;
  points.forEach(([x, y], i) => {
    if (i === 0 || i === points.length - 1) return;
    const distance = Math.abs(y - (y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)));
    if (distance > worst) {
      worst = distance;
      index = i;
    }
  });
  if (worst <= tolerance) return [first, last];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

const trim = (value: number, digits: number) => String(Number(value.toFixed(digits)));

/** The spring as a CSS `linear()` easing over `springDuration(spring)`. */
export function springEasing(spring: Spring): string {
  const duration = springDuration(spring) / 1000;
  const samples: Array<[number, number]> = [];
  const count = 240;
  for (let i = 0; i <= count; i++) {
    const progress = i / count;
    samples.push([progress, i === count ? 1 : springAt(spring, progress * duration)]);
  }
  const kept = simplify(samples, 0.0015);
  return `linear(${kept
    .map(([progress, value], i) =>
      i === 0 || i === kept.length - 1
        ? trim(value, 4)
        : `${trim(value, 4)} ${trim(progress * 100, 2)}%`
    )
    .join(", ")})`;
}

/** The CSS custom properties for every preset, as written at the top of setup.css's motion. */
export function springCss(): string {
  return Object.entries(SPRINGS)
    .map(
      ([name, spring]) =>
        `  --spring-${name}: ${springEasing(spring)};\n  --spring-${name}-duration: ${springDuration(spring)}ms;`
    )
    .join("\n");
}
