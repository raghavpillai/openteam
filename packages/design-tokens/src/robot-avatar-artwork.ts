import { ROBOT_AVATAR_SHAPES, type RobotAvatarShape } from "@openteam/contracts/robot-avatar";

/** SVG primitives as data: no React, DOM, or native runtime dependency. */
export interface RobotAvatarNode {
  readonly tag: "g" | "rect" | "circle" | "line" | "polygon";
  readonly attributes: Readonly<Record<string, string | number | Readonly<Record<string, string>>>>;
  readonly children?: readonly RobotAvatarNode[];
}

const node = (
  tag: RobotAvatarNode["tag"],
  attributes: RobotAvatarNode["attributes"],
  ...children: RobotAvatarNode[]
): RobotAvatarNode => ({ tag, attributes, ...(children.length ? { children } : {}) });

export const ROBOT_AVATAR_VIEW_BOX = "-4 -4 108 108";
export const robotAvatarFaceColor = (color: string): string =>
  color.toLowerCase() === "#242424" ? "#f2f2f2" : "#1b1b1d";
export const robotAvatarTempo = (shape: RobotAvatarShape): number =>
  6.4 + ROBOT_AVATAR_SHAPES.indexOf(shape) * 0.21;

/** The reference turns the face independently, so eye animations retain the perspective. */
const facePerspective = {
  transform: "perspective(300px) rotateY(14deg) translateX(2px)",
  transformOrigin: "50% 50%",
  transformBox: "fill-box",
} as const;

/** Vector artwork transcribed from the supplied Robot Avatars (1) reference. */
export const ROBOT_AVATAR_ARTWORK: Readonly<Record<RobotAvatarShape, readonly RobotAvatarNode[]>> =
  {
    classic: [
      node("rect", { x: "47", y: "6", width: "6", height: "18", rx: "3", fill: "currentColor" }),
      node("circle", {
        cx: "50",
        cy: "7",
        r: "5.5",
        fill: "currentColor",
        style: { transformBox: "fill-box", transformOrigin: "center" },
        "data-p": "antenna",
      }),
      node("rect", { x: "14", y: "22", width: "72", height: "62", rx: "14", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node("rect", {
          x: "24",
          y: "36",
          width: "52",
          height: "20",
          rx: "10",
          fill: "var(--robot-face, #1b1b1d)",
        }),
        node(
          "g",
          {
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
            "data-lim": "5",
          },
          node("circle", { cx: "40.5", cy: "46", r: "4" }),
          node("circle", { cx: "64.5", cy: "46", r: "4" })
        ),
        node(
          "g",
          { fill: "var(--robot-face, #1b1b1d)" },
          node("rect", {
            x: "35",
            y: "64",
            width: "8",
            height: "6",
            rx: "2.5",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "bar",
          }),
          node("rect", {
            x: "46",
            y: "64",
            width: "8",
            height: "6",
            rx: "2.5",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "bar",
          }),
          node("rect", {
            x: "57",
            y: "64",
            width: "8",
            height: "6",
            rx: "2.5",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "bar",
          })
        )
      ),
    ],
    goggles: [
      node(
        "g",
        { style: { transformBox: "fill-box", transformOrigin: "50% 90%" }, "data-p": "head" },
        node(
          "g",
          { fill: "currentColor" },
          node("rect", { x: "6", y: "40", width: "12", height: "24", rx: "4" }),
          node("rect", { x: "82", y: "40", width: "12", height: "24", rx: "4" }),
          node("rect", { x: "16", y: "14", width: "68", height: "74", rx: "18" })
        ),
        node(
          "g",
          { style: facePerspective },
          node(
            "g",
            { fill: "var(--robot-face, #1b1b1d)" },
            node("circle", { cx: "9", cy: "52", r: "2" }),
            node("circle", { cx: "91", cy: "52", r: "2" }),
            node("rect", { x: "26", y: "42", width: "48", height: "6", rx: "3" }),
            node("circle", { cx: "37", cy: "45", r: "11" }),
            node("circle", { cx: "63", cy: "45", r: "11" })
          ),
          node(
            "g",
            {
              fill: "currentColor",
              style: { transformBox: "fill-box", transformOrigin: "center" },
              "data-p": "eyes",
              "data-lim": "6",
            },
            node("circle", { cx: "40", cy: "45", r: "4.5" }),
            node("circle", { cx: "66", cy: "45", r: "4.5" })
          ),
          node("rect", {
            x: "40",
            y: "68",
            width: "20",
            height: "5",
            rx: "2.5",
            fill: "var(--robot-face, #1b1b1d)",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "mouth",
          })
        )
      ),
    ],
    "tv-head": [
      node(
        "g",
        { stroke: "currentColor", strokeWidth: "6", strokeLinecap: "round" },
        node("line", { x1: "34", y1: "24", x2: "22", y2: "8" }),
        node("line", { x1: "66", y1: "24", x2: "78", y2: "8" })
      ),
      node("rect", { x: "12", y: "24", width: "76", height: "58", rx: "12", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node("rect", {
          x: "22",
          y: "34",
          width: "56",
          height: "38",
          rx: "7",
          fill: "var(--robot-face, #1b1b1d)",
        }),
        node(
          "g",
          {
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
            "data-hide": "1",
          },
          node("rect", { x: "40", y: "46", width: "6", height: "14", rx: "3" }),
          node("rect", { x: "58", y: "46", width: "6", height: "14", rx: "3" })
        ),
        node(
          "g",
          { fill: "currentColor" },
          node("circle", { cx: "38", cy: "53", r: "4", opacity: "0", "data-p": "dot" }),
          node("circle", { cx: "50", cy: "53", r: "4", opacity: "0", "data-p": "dot" }),
          node("circle", { cx: "62", cy: "53", r: "4", opacity: "0", "data-p": "dot" })
        ),
        node(
          "g",
          { fill: "currentColor" },
          node("rect", {
            x: "32",
            y: "50",
            width: "4",
            height: "6",
            rx: "2",
            opacity: "0",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "barh",
          }),
          node("rect", {
            x: "40",
            y: "50",
            width: "4",
            height: "6",
            rx: "2",
            opacity: "0",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "barh",
          }),
          node("rect", {
            x: "48",
            y: "50",
            width: "4",
            height: "6",
            rx: "2",
            opacity: "0",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "barh",
          }),
          node("rect", {
            x: "56",
            y: "50",
            width: "4",
            height: "6",
            rx: "2",
            opacity: "0",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "barh",
          }),
          node("rect", {
            x: "64",
            y: "50",
            width: "4",
            height: "6",
            rx: "2",
            opacity: "0",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "barh",
          })
        )
      ),
    ],
    terminal: [
      node("rect", { x: "10", y: "20", width: "80", height: "66", rx: "16", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node("rect", {
          x: "20",
          y: "30",
          width: "60",
          height: "46",
          rx: "8",
          fill: "var(--robot-face, #1b1b1d)",
        }),
        node(
          "g",
          {
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
          },
          node("rect", { x: "34", y: "40", width: "9", height: "9", rx: "2" }),
          node("rect", { x: "61", y: "40", width: "9", height: "9", rx: "2" })
        ),
        node("rect", {
          x: "32",
          y: "58",
          width: "6",
          height: "10",
          fill: "currentColor",
          opacity: "0",
          "data-p": "cursor",
        }),
        node("rect", {
          x: "32",
          y: "58",
          width: "28",
          height: "4",
          rx: "2",
          fill: "currentColor",
          opacity: "0",
          style: { transformBox: "fill-box", transformOrigin: "left center" },
          "data-p": "line",
        }),
        node("rect", {
          x: "32",
          y: "65",
          width: "18",
          height: "4",
          rx: "2",
          fill: "currentColor",
          opacity: "0",
          style: { transformBox: "fill-box", transformOrigin: "left center" },
          "data-p": "line",
        })
      ),
      node(
        "g",
        { fill: "currentColor" },
        node("rect", { x: "30", y: "86", width: "40", height: "8", rx: "4" })
      ),
    ],
    pod: [
      node(
        "g",
        {},
        node("rect", {
          x: "12",
          y: "10",
          width: "76",
          height: "80",
          rx: "34",
          fill: "currentColor",
        }),
        node(
          "g",
          { style: facePerspective },
          node("rect", {
            x: "22",
            y: "30",
            width: "56",
            height: "24",
            rx: "12",
            fill: "var(--robot-face, #1b1b1d)",
          }),
          node(
            "g",
            {
              fill: "currentColor",
              style: { transformBox: "fill-box", transformOrigin: "center" },
              "data-p": "eyes",
              "data-lim": "4",
            },
            node("rect", { x: "39", y: "35", width: "7", height: "14", rx: "3.5" }),
            node("rect", { x: "58", y: "35", width: "7", height: "14", rx: "3.5" })
          ),
          node("circle", {
            cx: "50",
            cy: "64",
            r: "4.5",
            fill: "var(--robot-face, #1b1b1d)",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "mouth",
            "data-m": "o",
          })
        )
      ),
    ],
    "hex-visor": [
      node("polygon", {
        points: "50,8 87,29 87,71 50,92 13,71 13,29",
        fill: "currentColor",
        stroke: "currentColor",
        strokeWidth: "14",
        strokeLinejoin: "round",
        transform: "translate(50 50) scale(0.84) translate(-50 -50)",
      }),
      node(
        "g",
        { style: facePerspective },
        node("rect", {
          x: "22",
          y: "42",
          width: "56",
          height: "14",
          rx: "7",
          fill: "var(--robot-face, #1b1b1d)",
        }),
        node("rect", {
          x: "46",
          y: "45",
          width: "8",
          height: "8",
          rx: "4",
          fill: "currentColor",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "visor",
        }),
        node(
          "g",
          { fill: "var(--robot-face, #1b1b1d)" },
          node("rect", { x: "40", y: "63", width: "8", height: "4", rx: "2" }),
          node("rect", { x: "52", y: "63", width: "8", height: "4", rx: "2" })
        )
      ),
    ],
    chip: [
      node(
        "g",
        { fill: "currentColor", "data-p": "pin" },
        node("rect", { x: "30", y: "8", width: "7", height: "14", rx: "3" }),
        node("rect", { x: "46.5", y: "8", width: "7", height: "14", rx: "3" }),
        node("rect", { x: "63", y: "8", width: "7", height: "14", rx: "3" })
      ),
      node(
        "g",
        { fill: "currentColor", "data-p": "pin" },
        node("rect", { x: "78", y: "30", width: "14", height: "7", rx: "3" }),
        node("rect", { x: "78", y: "46.5", width: "14", height: "7", rx: "3" }),
        node("rect", { x: "78", y: "63", width: "14", height: "7", rx: "3" })
      ),
      node(
        "g",
        { fill: "currentColor", "data-p": "pin" },
        node("rect", { x: "30", y: "78", width: "7", height: "14", rx: "3" }),
        node("rect", { x: "46.5", y: "78", width: "7", height: "14", rx: "3" }),
        node("rect", { x: "63", y: "78", width: "7", height: "14", rx: "3" })
      ),
      node(
        "g",
        { fill: "currentColor", "data-p": "pin" },
        node("rect", { x: "8", y: "30", width: "14", height: "7", rx: "3" }),
        node("rect", { x: "8", y: "46.5", width: "14", height: "7", rx: "3" }),
        node("rect", { x: "8", y: "63", width: "14", height: "7", rx: "3" })
      ),
      node("rect", { x: "22", y: "22", width: "56", height: "56", rx: "10", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node(
          "g",
          {
            fill: "var(--robot-face, #1b1b1d)",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
          },
          node("rect", { x: "36", y: "39", width: "9", height: "9", rx: "2" }),
          node("rect", { x: "59", y: "39", width: "9", height: "9", rx: "2" })
        ),
        node("rect", {
          x: "41",
          y: "58",
          width: "18",
          height: "5",
          rx: "2.5",
          fill: "var(--robot-face, #1b1b1d)",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "mouth",
        })
      ),
    ],
    helmet: [
      node("circle", { cx: "50", cy: "50", r: "40", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node("rect", {
          x: "18",
          y: "30",
          width: "64",
          height: "36",
          rx: "18",
          fill: "var(--robot-face, #1b1b1d)",
        }),
        node(
          "g",
          {
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
            "data-grow": "1",
          },
          node("circle", { cx: "41", cy: "48", r: "4" }),
          node("circle", { cx: "63", cy: "48", r: "4" })
        ),
        node("rect", {
          x: "41",
          y: "74",
          width: "18",
          height: "5",
          rx: "2.5",
          fill: "var(--robot-face, #1b1b1d)",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "mouth",
        })
      ),
    ],
    bulb: [
      node("circle", {
        cx: "50",
        cy: "42",
        r: "37",
        fill: "currentColor",
        opacity: "0",
        style: { transformBox: "fill-box", transformOrigin: "center" },
        "data-p": "glow",
      }),
      node("circle", { cx: "50", cy: "42", r: "34", fill: "currentColor" }),
      node("rect", { x: "30", y: "60", width: "40", height: "34", rx: "8", fill: "currentColor" }),
      node(
        "g",
        { fill: "var(--robot-face, #1b1b1d)" },
        node("rect", { x: "35", y: "76", width: "30", height: "4", rx: "2" }),
        node("rect", { x: "35", y: "84", width: "30", height: "4", rx: "2" })
      ),
      node(
        "g",
        { style: facePerspective },
        node(
          "g",
          {
            fill: "var(--robot-face, #1b1b1d)",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
          },
          node("circle", { cx: "40", cy: "38", r: "5" }),
          node("circle", { cx: "64", cy: "38", r: "5" })
        ),
        node("rect", {
          x: "42",
          y: "52",
          width: "16",
          height: "5",
          rx: "2.5",
          fill: "var(--robot-face, #1b1b1d)",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "mouth",
        })
      ),
    ],
    owl: [
      node(
        "g",
        { fill: "currentColor", stroke: "currentColor", strokeWidth: "8", strokeLinejoin: "round" },
        node("polygon", { points: "28,34 24,14 42,28" }),
        node("polygon", { points: "72,34 76,14 58,28" })
      ),
      node("rect", { x: "14", y: "24", width: "72", height: "64", rx: "28", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node(
          "g",
          { fill: "var(--robot-face, #1b1b1d)" },
          node("circle", { cx: "36", cy: "48", r: "12" }),
          node("circle", { cx: "64", cy: "48", r: "12" })
        ),
        node(
          "g",
          {
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
            "data-lim": "6.5",
          },
          node("circle", { cx: "39.25", cy: "48", r: "4.5" }),
          node("circle", { cx: "67.25", cy: "48", r: "4.5" })
        ),
        node("polygon", {
          points: "45,64 55,64 50,71",
          fill: "var(--robot-face, #1b1b1d)",
          style: { transformBox: "fill-box", transformOrigin: "50% 0" },
          "data-p": "mouth",
        })
      ),
    ],
    periscope: [
      node(
        "g",
        { style: { transformBox: "fill-box", transformOrigin: "center" }, "data-p": "neck" },
        node("rect", {
          x: "43",
          y: "26",
          width: "14",
          height: "52",
          rx: "4",
          fill: "currentColor",
        }),
        node("circle", { cx: "50", cy: "26", r: "20", fill: "currentColor" }),
        node(
          "g",
          { style: facePerspective },
          node("circle", { cx: "50", cy: "26", r: "9.5", fill: "var(--robot-face, #1b1b1d)" }),
          node("circle", {
            cx: "52.5",
            cy: "26",
            r: "4",
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
            "data-lim": "5",
          })
        )
      ),
      node("rect", { x: "12", y: "56", width: "76", height: "36", rx: "14", fill: "currentColor" }),
      node(
        "g",
        { fill: "var(--robot-face, #1b1b1d)" },
        node("rect", {
          x: "34",
          y: "71",
          width: "8",
          height: "6",
          rx: "2.5",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "bar",
        }),
        node("rect", {
          x: "46",
          y: "71",
          width: "8",
          height: "6",
          rx: "2.5",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "bar",
        }),
        node("rect", {
          x: "58",
          y: "71",
          width: "8",
          height: "6",
          rx: "2.5",
          style: { transformBox: "fill-box", transformOrigin: "center" },
          "data-p": "bar",
        })
      ),
    ],
    "dual-screen": [
      node("rect", { x: "12", y: "14", width: "76", height: "72", rx: "16", fill: "currentColor" }),
      node(
        "g",
        { style: facePerspective },
        node(
          "g",
          { fill: "var(--robot-face, #1b1b1d)" },
          node("rect", { x: "20", y: "26", width: "26", height: "26", rx: "6" }),
          node("rect", { x: "54", y: "26", width: "26", height: "26", rx: "6" })
        ),
        node(
          "g",
          {
            fill: "currentColor",
            style: { transformBox: "fill-box", transformOrigin: "center" },
            "data-p": "eyes",
            "data-lim": "7",
          },
          node("rect", { x: "33.5", y: "36", width: "6", height: "6", rx: "1" }),
          node("rect", { x: "67.5", y: "36", width: "6", height: "6", rx: "1" })
        ),
        node(
          "g",
          { fill: "var(--robot-face, #1b1b1d)" },
          node("rect", { x: "32", y: "64", width: "6", height: "6", rx: "1", "data-p": "pix" }),
          node("rect", { x: "41", y: "64", width: "6", height: "6", rx: "1", "data-p": "pix" }),
          node("rect", { x: "50", y: "64", width: "6", height: "6", rx: "1", "data-p": "pix" }),
          node("rect", { x: "59", y: "64", width: "6", height: "6", rx: "1", "data-p": "pix" })
        )
      ),
    ],
  };
