import type { RobotAvatarShape } from "@openteam/contracts/robot-avatar";
import { ROBOT_AVATAR_ARTWORK, type RobotAvatarNode } from "./robot-avatar-artwork";

/** Expression and loading-glyph primitives layered onto the robot artwork, as data. */
export type RobotAvatarLayerNode =
  | RobotAvatarNode
  | {
      readonly tag: "g" | "circle" | "ellipse" | "path" | "rect";
      readonly attributes: Readonly<Record<string, string | number | Readonly<Record<string, string>>>>;
      readonly children?: readonly RobotAvatarLayerNode[];
    };

type Tag = "g" | "circle" | "ellipse" | "path" | "rect";
const layer = (
  tag: Tag,
  attributes: Readonly<Record<string, string | number | Readonly<Record<string, string>>>>,
  ...children: RobotAvatarLayerNode[]
): RobotAvatarLayerNode => ({ tag, attributes, ...(children.length ? { children } : {}) });

const num = (value: unknown) => Number(value ?? 0);
const fixed = (value: number) => +value.toFixed(2);

/** One eye's box, read from the artwork: centre, half width and half height. */
type Eye = { cx: number; cy: number; hw: number; hh: number; round: boolean };

function eyesOf(eyes: RobotAvatarNode): Eye[] {
  const shapes = eyes.children?.length ? eyes.children : [eyes];
  return shapes.flatMap((eye): Eye[] => {
    const a = eye.attributes;
    if (eye.tag === "circle") return [{ cx: num(a.cx), cy: num(a.cy), hw: num(a.r), hh: num(a.r), round: true }];
    if (eye.tag !== "rect") return [];
    const width = num(a.width);
    const height = num(a.height);
    return [
      {
        cx: num(a.x) + width / 2,
        cy: num(a.y) + height / 2,
        hw: width / 2,
        hh: height / 2,
        round: num(a.rx) * 2 >= Math.min(width, height),
      },
    ];
  });
}

/** Expression layers share the eyes' gaze range, so they always sit where the eyes are. */
const gazeRange = (eyes: RobotAvatarNode): Record<string, string | number> => {
  const range = eyes.attributes["data-lim"];
  return typeof range === "string" || typeof range === "number" ? { "data-lim": range } : {};
};
const paintOf = (eyes: RobotAvatarNode) => String(eyes.attributes.fill ?? "currentColor");

/** One arc per eye, drawn in the eye's own paint: upturned "^ ^", or closed and sleeping. */
function arcs(
  eyes: RobotAvatarNode,
  attributes: Record<string, string>,
  closed = false
): RobotAvatarLayerNode | null {
  const paths = eyesOf(eyes).map(({ cx, cy, hw, hh }) => {
    const half = Math.max(hw, Math.min(hh, hw * 1.6));
    const w = half * (closed ? 1.15 : 1.25);
    const d = closed
      ? `M${fixed(cx - w)} ${fixed(cy - half * 0.1)}Q${cx} ${fixed(cy + half * 1.05)} ${fixed(cx + w)} ${fixed(cy - half * 0.1)}`
      : `M${fixed(cx - w)} ${fixed(cy + half * 0.45)}Q${cx} ${fixed(cy - half * 1.35)} ${fixed(cx + w)} ${fixed(cy + half * 0.45)}`;
    return layer("path", { d, strokeWidth: fixed(Math.max(closed ? 1.9 : 2.2, half * (closed ? 0.62 : 0.8))) });
  });
  if (!paths.length) return null;
  return layer(
    "g",
    { ...attributes, ...gazeRange(eyes), fill: "none", stroke: paintOf(eyes), strokeLinecap: "round" },
    ...paths
  );
}

/** Eyes squeezed shut, "> <": the face a poke gets. A single eye squeezes into both halves. */
function squint(eyes: RobotAvatarNode): RobotAvatarLayerNode | null {
  const found = eyesOf(eyes);
  if (!found.length) return null;
  const pairs =
    found.length === 1
      ? [
          { ...found[0]!, cx: found[0]!.cx - found[0]!.hw * 1.15, side: 1 },
          { ...found[0]!, cx: found[0]!.cx + found[0]!.hw * 1.15, side: -1 },
        ].map((eye) => ({ ...eye, hw: eye.hw * 0.85, hh: eye.hh * 0.85 }))
      : found.map((eye, index) => ({ ...eye, side: index === 0 ? 1 : -1 }));
  const paths = pairs.map(({ cx, cy, hw, hh, side }) => {
    const w = Math.max(hw, 3) * 0.95;
    const h = Math.min(Math.max(hh, 3) * 0.95, w * 1.15);
    return layer("path", {
      d: `M${fixed(cx - side * w)} ${fixed(cy - h)}L${fixed(cx + side * w * 0.75)} ${cy}L${fixed(cx - side * w)} ${fixed(cy + h)}`,
      strokeWidth: fixed(Math.max(2.1, Math.min(hw, hh) * 0.72)),
    });
  });
  return layer(
    "g",
    {
      "data-x": "squint",
      ...gazeRange(eyes),
      fill: "none",
      stroke: paintOf(eyes),
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    ...paths
  );
}

/** Spiral eyes for a dizzy robot. Each spiral spins about its own centre. */
function dizzy(eyes: RobotAvatarNode): RobotAvatarLayerNode | null {
  const paths = eyesOf(eyes).map(({ cx, cy, hw, hh }) => {
    const radius = Math.max(5.6, Math.min(Math.max(hw, hh) * 1.55, 8.5));
    const points: string[] = [];
    const turns = 2;
    for (let step = 0; step <= 36; step++) {
      const t = step / 36;
      const angle = t * turns * Math.PI * 2;
      const r = radius * (0.12 + 0.88 * t);
      points.push(`${fixed(cx + Math.cos(angle) * r)} ${fixed(cy + Math.sin(angle) * r)}`);
    }
    return layer("path", { d: `M${points.join("L")}`, strokeWidth: fixed(Math.max(1.9, radius * 0.27)) });
  });
  if (!paths.length) return null;
  return layer(
    "g",
    {
      "data-x": "dizzy",
      ...gazeRange(eyes),
      fill: "none",
      stroke: paintOf(eyes),
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    ...paths
  );
}

/** Per-robot placement of the details that do not follow from the eyes. */
type Details = {
  /** Cheek centres and radii. */
  readonly cheeks: readonly [readonly [number, number], readonly [number, number]];
  readonly cheek: readonly [number, number];
  /** Where a nervous sweat drop forms, by the top corner of the head; sleepy z's rise from there too. */
  readonly sweat: readonly [number, number];
};
const DETAILS: Readonly<Record<RobotAvatarShape, Details>> = {
  classic: { cheeks: [[34.5, 52], [70.5, 52]], cheek: [4.3, 2.5], sweat: [84, 26] },
  goggles: { cheeks: [[26, 62], [74, 62]], cheek: [5, 3], sweat: [82, 16] },
  "tv-head": { cheeks: [[32, 63], [70, 63]], cheek: [4.8, 2.8], sweat: [86, 25] },
  terminal: { cheeks: [[29.5, 54], [74.5, 54]], cheek: [4.6, 2.6], sweat: [88, 19] },
  pod: { cheeks: [[31, 46.5], [72, 46.5]], cheek: [4.4, 2.6], sweat: [80, 13] },
  "hex-visor": { cheeks: [[30, 64], [70, 64]], cheek: [5, 2.8], sweat: [80, 22] },
  chip: { cheeks: [[32, 54.5], [72, 54.5]], cheek: [4.4, 2.6], sweat: [84, 16] },
  helmet: { cheeks: [[30.5, 57], [73.5, 57]], cheek: [5, 2.8], sweat: [80, 15] },
  bulb: { cheeks: [[31, 48], [72, 48]], cheek: [5, 3], sweat: [77, 12] },
  owl: { cheeks: [[25.5, 64], [74.5, 64]], cheek: [5, 3], sweat: [87, 27] },
  periscope: { cheeks: [[37.5, 35], [64.5, 35]], cheek: [3.6, 2.2], sweat: [70, 4] },
  "dual-screen": { cheeks: [[25, 59], [75, 59]], cheek: [4.6, 2.6], sweat: [87, 13] },
};

const blush = ({ cheeks, cheek: [rx, ry] }: Details) =>
  layer(
    "g",
    { "data-x": "blush", fill: "#ff5a8f" },
    ...cheeks.map(([cx, cy]) => layer("ellipse", { cx, cy, rx, ry }))
  );

/** A teardrop that beads up by the head and slides down. */
function sweat([x, y]: readonly [number, number]): RobotAvatarLayerNode {
  return layer("path", {
    "data-x": "sweat",
    d: `M${x} ${y}C${x + 1.6} ${y + 3} ${x + 4.6} ${y + 5.6} ${x + 4.6} ${y + 8.6}A4.6 4.6 0 0 1 ${x - 4.6} ${y + 8.6}C${x - 4.6} ${y + 5.6} ${x - 1.6} ${y + 3} ${x} ${y}Z`,
    fill: "#8fd8ff",
    stroke: "var(--robot-face, #1b1b1d)",
    strokeWidth: 1.6,
    strokeLinejoin: "round",
  });
}

/** "z z z" drifting up from the top corner of a dozing robot's head. */
function snore([x, y]: readonly [number, number]): RobotAvatarLayerNode {
  const size = 8;
  const z = (scale: number) => {
    const s = size * scale;
    return layer("path", { d: `M${fixed(x - 6)} ${fixed(y + 4)}h${fixed(s)}l${fixed(-s)} ${fixed(s)}h${fixed(s)}` });
  };
  return layer(
    "g",
    {
      "data-x": "zzz",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    z(1),
    z(0.8),
    z(0.65)
  );
}

/** A single rounded mouth turns into a frown when a run fails. */
function frown(mouth: RobotAvatarNode): RobotAvatarLayerNode | null {
  if (mouth.tag !== "rect") return null;
  const a = mouth.attributes;
  const x = num(a.x);
  const y = num(a.y);
  const width = num(a.width);
  const height = num(a.height);
  const inset = height / 2;
  return layer("path", {
    "data-x": "frown",
    d: `M${fixed(x + inset)} ${fixed(y + height * 0.85)}Q${fixed(x + width / 2)} ${fixed(y - height * 0.2)} ${fixed(x + width - inset)} ${fixed(y + height * 0.85)}`,
    fill: "none",
    stroke: String(a.fill ?? "currentColor"),
    strokeWidth: fixed(height * 0.85),
    strokeLinecap: "round",
  });
}

/** A single rounded mouth turns into a smile; a round one opens into a grin. */
function smile(mouth: RobotAvatarNode): RobotAvatarLayerNode | null {
  const a = mouth.attributes;
  if (mouth.tag === "rect") {
    const x = num(a.x);
    const y = num(a.y);
    const width = num(a.width);
    const height = num(a.height);
    const inset = height / 2;
    return layer("path", {
      "data-x": "smile",
      d: `M${fixed(x + inset)} ${fixed(y + inset * 0.6)}Q${fixed(x + width / 2)} ${fixed(y + height * 2.1)} ${fixed(x + width - inset)} ${fixed(y + inset * 0.6)}`,
      fill: "none",
      stroke: String(a.fill ?? "currentColor"),
      strokeWidth: height,
      strokeLinecap: "round",
    });
  }
  if (mouth.tag === "circle") {
    const cx = num(a.cx);
    const cy = num(a.cy);
    const r = num(a.r) * 1.2;
    return layer("path", {
      "data-x": "smile",
      d: `M${fixed(cx - r)} ${fixed(cy - r * 0.35)}A${fixed(r)} ${fixed(r)} 0 1 0 ${fixed(cx + r)} ${fixed(cy - r * 0.35)}Z`,
      fill: String(a.fill ?? "currentColor"),
    });
  }
  return null;
}

const isFace = (node: RobotAvatarNode) => {
  const style = node.attributes.style;
  return typeof style === "object" && String((style as Record<string, string>).transform ?? "").includes("perspective");
};

function withExpressions(nodes: readonly RobotAvatarNode[], details: Details): RobotAvatarLayerNode[] {
  return nodes.flatMap((node): RobotAvatarLayerNode[] => {
    const children = node.children ? withExpressions(node.children, details) : undefined;
    const part = node.attributes["data-p"];
    if (part === "eyes" || part === "visor") {
      // Gaze and blinks move this wrapper, leaving the eyes' own loops free.
      return [
        layer(
          "g",
          { "data-look": "", ...gazeRange(node) },
          ...[
            node as RobotAvatarLayerNode,
            arcs(node, { "data-p": "happy" }),
            arcs(node, { "data-x": "joy" }),
            arcs(node, { "data-x": "sleep" }, true),
            squint(node),
            dizzy(node),
          ].filter((layer): layer is RobotAvatarLayerNode => layer !== null)
        ),
      ];
    }
    if (part === "mouth") {
      const grin = smile(node);
      const sad = frown(node);
      if (grin) {
        const marks = { "data-smile": "", ...(sad ? { "data-frown": "" } : {}) };
        return [
          { ...node, attributes: { ...node.attributes, ...marks } } as RobotAvatarLayerNode,
          grin,
          ...(sad ? [sad] : []),
        ];
      }
    }
    const copy = { ...node, ...(children ? { children } : {}) } as RobotAvatarLayerNode;
    if (isFace(node) && copy.children) return [{ ...copy, children: [...copy.children, blush(details)] } as RobotAvatarLayerNode];
    return [copy];
  });
}

/** Robot artwork plus the expression layers each mode can reveal. */
export function robotAvatarLayers(shape: RobotAvatarShape): readonly RobotAvatarLayerNode[] {
  const details = DETAILS[shape];
  return [...withExpressions(ROBOT_AVATAR_ARTWORK[shape], details), sweat(details.sweat), snore(details.sweat)];
}

const spark = (x: number, y: number, size: number) =>
  layer("path", {
    "data-spark": "",
    d: `M${x} ${y - size}Q${x} ${y} ${x + size} ${y}Q${x} ${y} ${x} ${y + size}Q${x} ${y} ${x - size} ${y}Q${x} ${y} ${x} ${y - size}Z`,
  });

/**
 * Loading glyphs the robot folds into. The robot collapses into one shared core; each glyph
 * only adds satellites that grow out of that core, so switching glyphs never drops it.
 * Everything is drawn in the Bot's colour around the robot's centre.
 */
export const ROBOT_AVATAR_GLYPHS: readonly RobotAvatarLayerNode[] = [
  layer("g", { "data-g": "core" }, layer("circle", { "data-core": "", cx: 50, cy: 50, r: 12 })),
  layer(
    "g",
    { "data-g": "dots" },
    layer("circle", { "data-sat": "l", cx: 21, cy: 50, r: 10 }),
    layer("circle", { "data-sat": "r", cx: 79, cy: 50, r: 10 })
  ),
  layer(
    "g",
    { "data-g": "radar" },
    layer("circle", { "data-ring": "", cx: 50, cy: 50, r: 46, fill: "none", stroke: "currentColor", strokeWidth: 3 }),
    layer("circle", { "data-ring": "", cx: 50, cy: 50, r: 46, fill: "none", stroke: "currentColor", strokeWidth: 3 }),
    layer("circle", { "data-ring": "", cx: 50, cy: 50, r: 46, fill: "none", stroke: "currentColor", strokeWidth: 3 })
  ),
  layer(
    "g",
    { "data-g": "progress" },
    layer("circle", { "data-track": "", cx: 50, cy: 50, r: 36, fill: "none", stroke: "currentColor", strokeWidth: 9 }),
    layer("circle", {
      "data-arc": "",
      cx: 50,
      cy: 50,
      r: 36,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 9,
      strokeLinecap: "round",
      pathLength: 100,
      strokeDasharray: "100 100",
    })
  ),
  layer(
    "g",
    { "data-g": "orbit" },
    layer("circle", { "data-sat": "m", cx: 50, cy: 50, r: 7.5 }),
    layer("circle", { "data-sat": "m", cx: 50, cy: 50, r: 7.5 }),
    layer("circle", { "data-sat": "m", cx: 50, cy: 50, r: 7.5 })
  ),
  // Sending: messages leave the core for the upper right, one after another.
  layer(
    "g",
    { "data-g": "send" },
    layer("circle", { "data-sat": "s", cx: 50, cy: 50, r: 7 }),
    layer("circle", { "data-sat": "s", cx: 50, cy: 50, r: 7 })
  ),
  // Writing: a pencil drafts a line, lifts, and starts the next one.
  layer(
    "g",
    { "data-g": "pencil" },
    layer("path", {
      "data-ink": "",
      d: "M20 72q5-7 10 0t10 0t10 0t10 0",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      pathLength: 100,
      strokeDasharray: "100 100",
    }),
    layer(
      "g",
      { "data-sat": "p" },
      layer(
        "g",
        { "data-pen": "" },
        layer("path", {
          d: "M66 14l12 12l-30 30l-16 4l4-16z",
          stroke: "currentColor",
          strokeWidth: 3,
          strokeLinejoin: "round",
        }),
        layer("path", { d: "M61 19l12 12", fill: "none", stroke: "var(--robot-face, #1b1b1d)", strokeWidth: 3 })
      )
    )
  ),
  // Spawning: specks gather from all around and fill the core.
  layer(
    "g",
    { "data-g": "gather" },
    layer("circle", { "data-sat": "g", cx: 50, cy: 50, r: 6 }),
    layer("circle", { "data-sat": "g", cx: 50, cy: 50, r: 6 }),
    layer("circle", { "data-sat": "g", cx: 50, cy: 50, r: 6 }),
    layer("circle", { "data-sat": "g", cx: 50, cy: 50, r: 6 })
  ),
  layer(
    "g",
    { "data-g": "sparkles" },
    spark(12, 14, 7),
    spark(90, 8, 6),
    spark(97, 40, 4.5),
    spark(4, 46, 4),
    spark(70, -1, 3.5)
  ),
];
