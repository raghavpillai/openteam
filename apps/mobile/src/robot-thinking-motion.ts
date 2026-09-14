import type { RobotAvatarNode } from "@openteam/design-tokens/robot-avatar-artwork";

type Bounds = [number, number, number, number];
const bounds = (node: RobotAvatarNode): Bounds => {
  const a = node.attributes;
  const n = (key: string) => Number(a[key] ?? 0);
  if (node.tag === "rect") return [n("x"), n("y"), n("x") + n("width"), n("y") + n("height")];
  if (node.tag === "circle")
    return [n("cx") - n("r"), n("cy") - n("r"), n("cx") + n("r"), n("cy") + n("r")];
  if (node.tag === "line")
    return [
      Math.min(n("x1"), n("x2")),
      Math.min(n("y1"), n("y2")),
      Math.max(n("x1"), n("x2")),
      Math.max(n("y1"), n("y2")),
    ];
  if (node.tag === "polygon") {
    const points = String(a.points)
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const xs = points.filter((_, i) => i % 2 === 0),
      ys = points.filter((_, i) => i % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const children = (node.children ?? []).map(bounds);
  return children.length
    ? [
        Math.min(...children.map((b) => b[0])),
        Math.min(...children.map((b) => b[1])),
        Math.max(...children.map((b) => b[2])),
        Math.max(...children.map((b) => b[3])),
      ]
    : [50, 50, 50, 50];
};

export function robotNodeCenter(node: RobotAvatarNode): [number, number] {
  const [x1, y1, x2, y2] = bounds(node);
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

// CSS ease-in-out, shared with robot-avatar.css's keyframe timing.
function ease(x: number) {
  "worklet";
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 12; i++) {
    const t = (lo + hi) / 2;
    const curve = 3 * (1 - t) ** 2 * t * 0.42 + 3 * (1 - t) * t ** 2 * 0.58 + t ** 3;
    if (curve < x) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  return 3 * (1 - t) * t ** 2 + t ** 3;
}

function keyframe(
  time: number,
  duration: number,
  points: readonly (readonly [number, number])[],
  delay = 0
) {
  "worklet";
  if (time < delay) return points[0]?.[1] ?? 0;
  const phase = ((time - delay) % duration) / duration;
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1],
      right = points[i];
    if (!left || !right) continue;
    if (phase <= right[0])
      return left[1] + (right[1] - left[1]) * ease((phase - left[0]) / (right[0] - left[0]));
  }
  return points.at(-1)?.[1] ?? 0;
}

/** Native poses use the same parts, periods, gaze limits and keyframes as our web robot. */
export function robotThinkingPose(
  part: string,
  time: number,
  tempo: number,
  limit: number,
  index: number,
  center: readonly [number, number]
) {
  "worklet";
  let x = 0,
    y = 0,
    sx = 1,
    sy = 1,
    rotation = 0,
    opacity = 1;
  const pulse = (duration: number, a: number, b: number, delay = 0) => {
    "worklet";
    return keyframe(
      time,
      duration,
      [
        [0, a],
        [0.5, b],
        [1, a],
      ],
      delay
    );
  };
  if (part === "body") {
    rotation = pulse(4200, -1, 1.5);
    y = -1;
  }
  if (part === "eyes") {
    const gx = limit === 4 ? 3 : limit === 5 ? 3.5 : limit >= 6 ? 4 : 5;
    const gy =
      limit <= 5 && limit > 0 ? -2 : limit === 6 || limit === 6.5 ? -3 : limit === 7 ? -4 : -5;
    x = keyframe(time, tempo, [
      [0, 0],
      [0.08, gx],
      [0.32, gx],
      [0.42, -gx],
      [0.69, -gx],
      [0.76, 0],
      [0.8, 0],
      [0.94, 0],
      [1, 0],
    ]);
    y = keyframe(time, tempo, [
      [0, 0],
      [0.08, gy],
      [0.32, gy],
      [0.42, gy],
      [0.69, gy],
      [0.76, 0],
      [0.8, 0],
      [1, 0],
    ]);
    sy = keyframe(time, tempo, [
      [0, 1],
      [0.69, 1],
      [0.76, 0.08],
      [0.8, 1],
      [1, 1],
    ]);
  }
  if (part === "visor") x = pulse(2600, -17, 17);
  if (part === "dot")
    opacity = keyframe(
      time,
      1200,
      [
        [0, 0.18],
        [0.3, 1],
        [0.7, 0.18],
        [1, 0.18],
      ],
      index === 1 ? 160 : index === 2 ? 320 : 0
    );
  if (part === "antenna") {
    sx = sy = pulse(1400, 1, 1.5);
    opacity = pulse(1400, 1, 0.45);
  }
  if (part === "head") rotation = pulse(4800, -5, 5);
  if (part === "pin") opacity = pulse(1400, 1, 0.2, index >= 1 && index <= 3 ? index * 210 : 0);
  if (part === "glow") {
    sx = sy = pulse(1700, 1, 1.07);
    opacity = pulse(1700, 1, 0.22);
  }
  if (part === "neck")
    y = keyframe(time, 3600, [
      [0, 0],
      [0.3, -8],
      [0.65, -8],
      [1, 0],
    ]);
  if (part === "cursor") opacity = time % 1100 < 550 ? 0.7 : 0;
  const angle = (rotation * Math.PI) / 180;
  const a = Math.cos(angle) * sx,
    b = Math.sin(angle) * sx,
    c = -Math.sin(angle) * sy,
    d = Math.cos(angle) * sy;
  return {
    matrix: [
      a,
      b,
      c,
      d,
      center[0] + x - a * center[0] - c * center[1],
      center[1] + y - b * center[0] - d * center[1],
    ],
    opacity,
  };
}
