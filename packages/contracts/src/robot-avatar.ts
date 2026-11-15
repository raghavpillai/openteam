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

/**
 * What an avatar shows. Busy Bots either keep the robot moving (working, typing) or fold it
 * into a loading glyph: thinking dots, searching radar, generating progress, connecting orbit
 * (apps and long waits), writing pencil, sending a message, and spawning on a first entrance.
 * Done and failed react to a run this client watched; waiting is a Bot waiting on the person,
 * and turns drowsy after a while. Sleeping and waking belong to the Bot's computer.
 */
export const BOT_AVATAR_MODES = [
  "still",
  "idle",
  "working",
  "typing",
  "thinking",
  "searching",
  "generating",
  "connecting",
  "writing",
  "sending",
  "spawning",
  "done",
  "failed",
  "waiting",
  "drowsy",
  "sleeping",
  "waking",
] as const;
export type BotAvatarMode = (typeof BOT_AVATAR_MODES)[number];
/** Modes that fold the robot into a loading glyph. */
export const BOT_AVATAR_GLYPH_MODES = [
  "thinking",
  "searching",
  "generating",
  "connecting",
  "writing",
  "sending",
  "spawning",
] as const;
