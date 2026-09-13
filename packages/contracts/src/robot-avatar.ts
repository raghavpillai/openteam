/** Robot identities shared by profile storage, clients, and artwork. */
export const ROBOT_AVATAR_SHAPES = [
  "classic",
  "goggles",
  "tv-head",
  "terminal",
  "pod",
  "hex-visor",
  "chip",
  "helmet",
  "bulb",
  "owl",
  "periscope",
  "dual-screen",
] as const;
export type RobotAvatarShape = (typeof ROBOT_AVATAR_SHAPES)[number];

export const DEFAULT_ROBOT_AVATAR_SHAPE = "chip" satisfies RobotAvatarShape;

export const normalizeRobotAvatarShape = (icon?: string | null): RobotAvatarShape => {
  const value = icon?.trim().toLowerCase() ?? "";
  return ROBOT_AVATAR_SHAPES.find((shape) => shape === value) ?? DEFAULT_ROBOT_AVATAR_SHAPE;
};
export const ROBOT_AVATAR_LABELS = {
  classic: "Classic",
  goggles: "Goggles",
  "tv-head": "TV head",
  terminal: "Terminal",
  pod: "Pod",
  "hex-visor": "Hex visor",
  chip: "Chip",
  helmet: "Helmet",
  bulb: "Bulb",
  owl: "Owl",
  periscope: "Periscope",
  "dual-screen": "Dual screen",
} as const;

export type BotAvatarMode = "still" | "idle" | "thinking";
