import { ROBOT_AVATAR_ANTENNA_WOBBLE, robotAvatarSpin, type RobotAvatarReaction } from "./robot-avatar-motion";

/*
 * Reactions for a robot someone is playing with. Keyframes leave out offsets 0 and 1, so
 * every reaction starts from the live pose (gaze lean included) and lands back on it.
 */

/** The wrapper around the eyes and the faces that replace them. */
const EYES = "[data-look]";
const MOUTH = '[data-p="mouth"]';
const EASE = "cubic-bezier(0.45, 0, 0.55, 1)";

/** Click reactions, played in turn: a spin, a bounce and a nod. */
export const ROBOT_AVATAR_POKES: readonly RobotAvatarReaction[] = [
  {
    // A hop with a full spin in perspective, eyes squeezed shut for the ride.
    duration: 900,
    keyframes: [
      { offset: 0.12, transform: robotAvatarSpin(0, 0, 1.08, 0.9), easing: "cubic-bezier(0.2, 0.6, 0.35, 1)" },
      { offset: 0.46, transform: robotAvatarSpin(-10, 200, 0.97, 1.05), easing: "cubic-bezier(0.45, 0, 0.75, 0.4)" },
      { offset: 0.74, transform: robotAvatarSpin(0, 360, 1.06, 0.94), easing: "ease-out" },
      { offset: 0.88, transform: robotAvatarSpin(-1.5, 360, 0.99, 1.01), easing: "ease-in-out" },
    ],
    antenna: { delay: 420, ...ROBOT_AVATAR_ANTENNA_WOBBLE },
    expressions: [
      { name: "squint", duration: 760 },
      { name: "blush", delay: 640, duration: 1_400 },
    ],
  },
  {
    duration: 820,
    keyframes: [
      { offset: 0.11, translate: "0 0", scale: "1.1 0.88", easing: "cubic-bezier(0.2, 0.6, 0.35, 1)" },
      { offset: 0.36, translate: "0 -16px", scale: "0.94 1.07", easing: "cubic-bezier(0.55, 0, 0.8, 0.3)" },
      { offset: 0.62, translate: "0 0", scale: "1.1 0.9", easing: "cubic-bezier(0.2, 0.6, 0.35, 1)" },
      { offset: 0.78, translate: "0 -1.5px", scale: "0.96 1.04", easing: "ease-in-out" },
      { offset: 0.9, translate: "0 0", scale: "1.02 0.98", easing: "ease-in-out" },
    ],
    antenna: { delay: 300, ...ROBOT_AVATAR_ANTENNA_WOBBLE },
    expressions: [
      { name: "squint", delay: 20, duration: 560 },
      { name: "blush", delay: 40, duration: 1_500 },
    ],
  },
  {
    duration: 480,
    keyframes: [
      { offset: 0.35, translate: "0 5px", scale: "1.04 0.95", easing: "ease-in-out" },
      { offset: 0.7, translate: "0 -1.5px", scale: "0.99 1.01", easing: "ease-in-out" },
    ],
    expressions: [{ name: "joy", delay: 40, duration: 520 }],
  },
];

/** Five quick pokes in a row: spiral eyes and a woozy sway. */
export const ROBOT_AVATAR_DIZZY: RobotAvatarReaction = {
  duration: 1_900,
  keyframes: [
    { offset: 0.08, rotate: "-10deg", translate: "-1.5px 0", easing: EASE },
    { offset: 0.24, rotate: "9deg", translate: "1.5px -1px", easing: EASE },
    { offset: 0.41, rotate: "-7deg", translate: "-1px 0", easing: EASE },
    { offset: 0.58, rotate: "5deg", translate: "1px -0.5px", easing: EASE },
    { offset: 0.74, rotate: "-3deg", translate: "0 0", easing: EASE },
    { offset: 0.88, rotate: "1deg", easing: EASE },
  ],
  antenna: { delay: 120, duration: 1_200, keyframes: [{ offset: 0.2, scale: "1.3" }, { offset: 0.45, scale: "0.85" }, { offset: 0.7, scale: "1.12" }] },
  expressions: [{ name: "dizzy", duration: 2_000 }],
};

const tilt = (direction: 1 | -1): RobotAvatarReaction => ({
  duration: 1_500,
  keyframes: [
    { offset: 0.2, rotate: `${10 * direction}deg`, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" },
    { offset: 0.76, rotate: `${8.5 * direction}deg`, easing: EASE },
  ],
  antenna: { delay: 220, ...ROBOT_AVATAR_ANTENNA_WOBBLE },
  parts: [
    {
      selector: EYES,
      duration: 1_500,
      keyframes: [
        { offset: 0.22, scale: "1.16" },
        { offset: 0.74, scale: "1.14" },
      ],
    },
  ],
});

/**
 * Small things an idle robot does on its own now and then. A look-around is not listed:
 * it rides the gaze springs, so the face turns with it.
 */
export const ROBOT_AVATAR_FIDGETS = {
  doubleBlink: {
    duration: 0,
    parts: [
      {
        selector: EYES,
        duration: 560,
        keyframes: [
          { offset: 0.16, scale: "1.05 0.08" },
          { offset: 0.34, scale: "1 1" },
          { offset: 0.52, scale: "1.05 0.08" },
        ],
      },
    ],
  },
  tiltLeft: tilt(-1),
  tiltRight: tilt(1),
  hop: {
    duration: 920,
    keyframes: [
      { offset: 0.1, translate: "0 0", scale: "1.06 0.92", easing: "ease-out" },
      { offset: 0.26, translate: "0 -7px", scale: "0.96 1.05", easing: "cubic-bezier(0.55, 0, 0.8, 0.3)" },
      { offset: 0.42, translate: "0 0", scale: "1.05 0.95", easing: "ease-out" },
      { offset: 0.56, translate: "0 -3.5px", scale: "0.98 1.02", easing: "cubic-bezier(0.55, 0, 0.8, 0.3)" },
      { offset: 0.7, translate: "0 0", scale: "1.03 0.97", easing: "ease-out" },
    ],
    antenna: { delay: 220, ...ROBOT_AVATAR_ANTENNA_WOBBLE },
  },
  /** A yawn: eyelids droop, the mouth opens wide, the body sags, then it shakes itself awake. */
  sleepy: {
    duration: 2_100,
    keyframes: [
      { offset: 0.3, translate: "0 1.4px", scale: "1.015 0.985", easing: EASE },
      { offset: 0.68, translate: "0 1.9px", scale: "1.02 0.978", easing: "ease-in" },
      { offset: 0.78, translate: "0 -1.6px", scale: "0.975 1.035", easing: "ease-out" },
      { offset: 0.88, translate: "0 0.3px", scale: "1.01 0.99", easing: "ease-in-out" },
    ],
    parts: [
      {
        selector: EYES,
        duration: 2_100,
        keyframes: [
          { offset: 0.28, scale: "1.02 0.42", easing: EASE },
          { offset: 0.5, scale: "1.02 0.3", easing: EASE },
          { offset: 0.68, scale: "1.03 0.1", easing: "ease-out" },
          { offset: 0.78, scale: "1.1 1.14", easing: "ease-out" },
          { offset: 0.9, scale: "1 1" },
        ],
      },
      {
        selector: MOUTH,
        duration: 2_100,
        keyframes: [
          { offset: 0.22, scale: "1 1", easing: EASE },
          { offset: 0.42, scale: "1.12 2.3", easing: EASE },
          { offset: 0.6, scale: "1.08 2.1", easing: "ease-in" },
          { offset: 0.7, scale: "1 0.8", easing: "ease-out" },
        ],
      },
    ],
    antenna: { delay: 1_600, ...ROBOT_AVATAR_ANTENNA_WOBBLE },
  },
  /** Eyes closed, swaying to a tune only it can hear. */
  hum: {
    duration: 1_800,
    keyframes: [
      { offset: 0.16, rotate: "-5deg", easing: EASE },
      { offset: 0.4, rotate: "5deg", easing: EASE },
      { offset: 0.64, rotate: "-4deg", easing: EASE },
      { offset: 0.84, rotate: "1.5deg", easing: EASE },
    ],
    expressions: [{ name: "joy", delay: 80, duration: 1_560 }],
  },
  antenna: {
    duration: 0,
    antenna: {
      delay: 0,
      duration: 900,
      keyframes: [
        { offset: 0.18, scale: "1.38" },
        { offset: 0.38, scale: "0.82" },
        { offset: 0.58, scale: "1.16" },
        { offset: 0.78, scale: "0.95" },
      ],
    },
  },
} satisfies Record<string, RobotAvatarReaction>;
export type RobotAvatarFidget = keyof typeof ROBOT_AVATAR_FIDGETS | "look";
