import type { BotAvatarShape as LegacyBotAvatarShape } from "./bot-avatar";

/** Robot identities shared by clients; the legacy silhouette IDs remain readable. */
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

// Existing saved avatars keep a stable identity without rewriting bot profiles.
const LEGACY_ROBOTS: Record<LegacyBotAvatarShape, RobotAvatarShape> = {
  circle: "helmet",
  blob: "goggles",
  square: "tv-head",
  pill: "terminal",
  triangle: "classic",
  hexagon: "hex-visor",
  cloud: "chip",
  drop: "pod",
};
export const normalizeRobotAvatarShape = (icon?: string | null): RobotAvatarShape => {
  const value = icon?.trim().toLowerCase() ?? "";
  return (
    ROBOT_AVATAR_SHAPES.find((shape) => shape === value) ??
    (Object.hasOwn(LEGACY_ROBOTS, value)
      ? LEGACY_ROBOTS[value as LegacyBotAvatarShape]
      : undefined) ??
    "chip"
  );
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
