import type { BotAvatarShape } from "@openbot/contracts/bot-avatar";

export const BOT_AVATAR_VIEW_BOX = "0 0 40 40";

export interface BotAvatarEyes {
  left: readonly [number, number];
  right: readonly [number, number];
  leftHeight?: number;
  leftWidth?: number;
  rightHeight?: number;
  rightWidth?: number;
}

export interface BotAvatarEyeRect {
  height: number;
  rotation: number;
  rx: number;
  width: number;
  x: number;
  y: number;
}

export const botAvatarEyeTransform = (eye: BotAvatarEyeRect): string =>
  `rotate(${eye.rotation} ${eye.x + eye.width / 2} ${eye.y + eye.height / 2})`;

export const botAvatarEyeRects = ({
  left,
  leftHeight = 6.4,
  leftWidth = 3.75,
  right,
  rightHeight = 6.4,
  rightWidth = 2.9,
}: BotAvatarEyes): readonly [BotAvatarEyeRect, BotAvatarEyeRect] => {
  const leftX = left[0] + 0.175;
  const leftY = left[1] + 0.1;
  const rightX = right[0] + 1.3;
  const rightY = right[1] - 0.25;
  return [
    {
      height: leftHeight,
      rotation: -16,
      rx: leftWidth / 2,
      width: leftWidth,
      x: leftX,
      y: leftY,
    },
    {
      height: rightHeight,
      rotation: -16,
      rx: rightWidth / 2,
      width: rightWidth,
      x: rightX,
      y: rightY,
    },
  ];
};

export type BotAvatarBody =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "path"; d: string; transform?: string };

export interface BotAvatarArtwork {
  body: BotAvatarBody;
  eyes: BotAvatarEyes;
}

export type BotAvatarNativePrimitive =
  | {
      kind: "ellipse";
      x: number;
      y: number;
      width: number;
      height: number;
      rotation?: number;
    }
  | {
      kind: "rounded-rect";
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
      rotation?: number;
    }
  | {
      kind: "triangle";
      x: number;
      y: number;
      width: number;
      height: number;
    };

/** Native-view body primitives for clients that do not otherwise need an SVG runtime. */
export const BOT_AVATAR_NATIVE_ARTWORK = {
  circle: [{ kind: "ellipse", x: 1.65, y: 1.65, width: 36.7, height: 36.7 }],
  blob: [
    {
      kind: "rounded-rect",
      x: 1.5,
      y: 2.2,
      width: 37,
      height: 35.5,
      radius: 16,
      rotation: -4,
    },
    { kind: "ellipse", x: 4, y: 1.4, width: 29, height: 36 },
  ],
  square: [{ kind: "rounded-rect", x: 3.3, y: 3.3, width: 33.4, height: 33.4, radius: 9 }],
  pill: [{ kind: "rounded-rect", x: 1, y: 7.2, width: 38, height: 25.6, radius: 13 }],
  triangle: [{ kind: "triangle", x: 1.6, y: 2.8, width: 36.8, height: 34.4 }],
  hexagon: [
    {
      kind: "rounded-rect",
      x: 7,
      y: 3,
      width: 26,
      height: 34,
      radius: 5,
      rotation: 30,
    },
    {
      kind: "rounded-rect",
      x: 7,
      y: 3,
      width: 26,
      height: 34,
      radius: 5,
      rotation: -30,
    },
  ],
  cloud: [
    { kind: "ellipse", x: 1, y: 13, width: 38, height: 22 },
    { kind: "ellipse", x: 7, y: 6, width: 22, height: 27 },
    { kind: "ellipse", x: 21, y: 8, width: 16, height: 24 },
  ],
  drop: [
    { kind: "triangle", x: 8, y: 2.5, width: 24, height: 21 },
    { kind: "ellipse", x: 5.8, y: 12, width: 28.4, height: 26 },
  ],
} as const satisfies Record<BotAvatarShape, readonly BotAvatarNativePrimitive[]>;

/** Renderer-neutral source of truth for the Bot mark. */
export const BOT_AVATAR_ARTWORK = {
  circle: {
    body: { kind: "circle", cx: 20, cy: 20, r: 18.35 },
    eyes: { left: [19, 13], right: [28.8, 11.8] },
  },
  blob: {
    body: {
      kind: "path",
      d: "M15 2.8C10.4 3.5 5.1 7 2.3 12 .5 16.5.5 23.8 2.8 27.5 5 32 10.5 34.5 16.5 36.3c4.2 1.05 9.5 1.05 13.5-.2 5.8-2.4 7.6-7 8.4-11.4C39.1 19 36.5 12 32.5 7.5 30.3 3 25 1.5 15 2.8Z",
      transform: "matrix(.995 0 0 .99 .1 .2)",
    },
    eyes: { left: [18.9, 12.5], right: [28.95, 11.55] },
  },
  square: {
    body: {
      kind: "path",
      d: "M13.6 5h12.8C32.3 5 35 7.7 35 13.6v12.8c0 5.9-2.7 8.6-8.6 8.6H13.6C7.7 35 5 32.3 5 26.4V13.6C5 7.7 7.7 5 13.6 5Z",
      transform: "matrix(1.11 0 0 1.11 -2.2 -2.2)",
    },
    eyes: { left: [18.8, 12.85], leftHeight: 7, right: [28.05, 12.45], rightWidth: 2.7 },
  },
  pill: {
    body: {
      kind: "path",
      d: "M13.6 8.5h12.8C33.3 8.5 38 13.5 38 20s-4.7 11.5-11.4 11.5H13.6C6.7 31.5 2 26.5 2 20S6.7 8.5 13.6 8.5Z",
      transform: "matrix(1.095 0 0 1.11 -1.9 -2.2)",
    },
    eyes: { left: [18.92, 14.22], leftWidth: 4, right: [29.2, 13.5] },
  },
  triangle: {
    body: {
      kind: "path",
      d: "M17.3 4.7c.7-1.2 1.5-1.9 2.7-1.9s2 .7 2.7 1.9C27 8 35.8 23 38.5 31c.9 3.2-2.5 6.2-4.2 6.2H5.7C4 37.2.6 34.2 1.5 31 4.2 23 13 8 17.3 4.7Z",
      transform: "matrix(.985 0 0 1 .15 0)",
    },
    eyes: { left: [18.45, 18], right: [26.25, 17.25] },
  },
  hexagon: {
    body: {
      kind: "path",
      d: "M17.6 1.8a4.8 4.8 0 0 1 4.8 0l13.3 7.3a4 4 0 0 1 1 3.7v14.4a4 4 0 0 1-1.5 3.7l-13.1 7.3a4.2 4.2 0 0 1-4.2 0L4.8 30.9a4 4 0 0 1-2-3.7V12.8a4 4 0 0 1 1.5-3.7l13.3-7.3Z",
      transform: "matrix(.984 0 0 1 .32 0)",
    },
    eyes: {
      left: [18.78, 12.95],
      leftHeight: 6.7,
      right: [28.55, 11.4],
      rightHeight: 6.9,
    },
  },
  cloud: {
    body: {
      kind: "path",
      d: "M8.2 32.3C3.6 31.9.8 28.6 1.5 24.2c.5-3.5 2.8-6.1 6-7-.4-5.1 3.3-9.6 8.4-10.2 3.3-.4 6.1.7 8.1 2.9 2-1.5 4.5-2.1 7.1-1.3 4.3 1.3 6.9 5.5 6.1 9.8 2 2 3 5 2 7.9-1.1 3.3-4.1 5.4-7.4 5.5-2.2 2.7-5.9 3.5-9 2-3.5 2.4-8.3 1.9-11.2-1-1.1.2-2.3.1-3.4-.5Z",
      transform: "matrix(1.04 0 0 1.12 -.8 -2.62)",
    },
    eyes: { left: [19.33, 15.78], right: [27.6, 14.28] },
  },
  drop: {
    body: {
      kind: "path",
      d: "M19.3 2.7c.4-.5 1-.5 1.4 0C25.5 6.5 35 17.4 34 26c-.7 6.5-7 11.5-14 11.5S6.7 32.5 6 26C5 17.4 14.5 6.5 19.3 2.7Z",
      transform: "matrix(1.11 0 0 1.13 -2.2 -3.13)",
    },
    eyes: { left: [18.78, 16.95], right: [27.55, 15.73], rightWidth: 2.7 },
  },
} as const satisfies Record<BotAvatarShape, BotAvatarArtwork>;
