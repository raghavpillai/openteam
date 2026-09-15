import {
  DEFAULT_ROBOT_AVATAR_SHAPE,
  ROBOT_AVATAR_SHAPES,
  type RobotAvatarShape,
} from "./robot-avatar";

/** Picker order: black followed by the ten automatically dealt colors. */
export const BOT_AVATAR_COLORS = [
  "#242424",
  "#a47952",
  "#f23d52",
  "#ff7a1a",
  "#ff9e12",
  "#10b972",
  "#27baae",
  "#4b8efb",
  "#925df2",
  "#ef479b",
  "#878787",
] as const;

export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

/** Captured model-tool spellings, in the same order as the native picker. */
export const BOT_AVATAR_COLOR_NAMES = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;
export const resolveBotAvatarColorName = (value: string): string => {
  const index = BOT_AVATAR_COLOR_NAMES.findIndex((name) => name === value);
  return index < 0 ? value : BOT_AVATAR_COLORS[index]!;
};

/** Fresh bots may receive every picker color except black. */
export const BOT_AVATAR_DEALT_COLORS = [
  "#a47952",
  "#f23d52",
  "#ff7a1a",
  "#ff9e12",
  "#10b972",
  "#27baae",
  "#4b8efb",
  "#925df2",
  "#ef479b",
  "#878787",
] as const satisfies readonly BotAvatarColor[];

export const DEFAULT_BOT_AVATAR = {
  shape: DEFAULT_ROBOT_AVATAR_SHAPE,
  icon: DEFAULT_ROBOT_AVATAR_SHAPE,
  color: "#ff7a1a",
} as const satisfies {
  shape: RobotAvatarShape;
  icon: RobotAvatarShape;
  color: BotAvatarColor;
};

const COLOR_SEED = Math.imul(1, 2_654_435_769);

/** FNV-1a over UTF-16 code units, kept in the unsigned 32-bit domain. */
export const hashBotAvatarKey = (key: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

/** Mulberry32: a tiny deterministic PRNG used for the color deal. */
const botAvatarRandom = (initialSeed: number) => {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (seed + 0x6d2b_79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const botAvatarColorForKey = (key: string): BotAvatarColor => {
  const seed = (hashBotAvatarKey(key) ^ COLOR_SEED) >>> 0;
  const random = botAvatarRandom((seed ^ COLOR_SEED) >>> 0);
  return (
    BOT_AVATAR_DEALT_COLORS[Math.floor(random() * BOT_AVATAR_DEALT_COLORS.length)] ??
    BOT_AVATAR_DEALT_COLORS[0]
  );
};

export const botAvatarShapeForKey = (key: string): RobotAvatarShape => {
  let hash = hashBotAvatarKey(key) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 73_244_475);
  hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return ROBOT_AVATAR_SHAPES[hash % ROBOT_AVATAR_SHAPES.length] ?? ROBOT_AVATAR_SHAPES[0];
};

const knownShape = (value?: string | null): RobotAvatarShape | undefined => {
  const candidate = value?.trim().toLowerCase();
  return ROBOT_AVATAR_SHAPES.find((shape) => shape === candidate);
};

const knownColor = (value?: string | null): string | undefined => {
  const candidate = value?.trim().toLowerCase();
  return candidate && /^#[0-9a-f]{6}$/.test(candidate) ? candidate : undefined;
};

export const resolveBotAvatarMark = ({
  agentId,
  avatarShape,
  avatarColor,
}: {
  agentId: string;
  avatarShape?: string | null;
  avatarColor?: string | null;
}): { shape: RobotAvatarShape; color: string } => ({
  shape: knownShape(avatarShape) ?? botAvatarShapeForKey(agentId),
  color: knownColor(avatarColor) ?? botAvatarColorForKey(agentId),
});
