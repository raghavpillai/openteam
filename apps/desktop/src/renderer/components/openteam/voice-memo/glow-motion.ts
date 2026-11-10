/** Matches VoiceProcessingSweep in iOS VoiceMemoGesture.swift (seconds). */
export function processingSweep(elapsed: number, reducedMotion = false) {
  const t = Math.max(0, elapsed);
  const progress = Math.min(1, t / 0.45);
  const gather = progress * progress * (3 - 2 * progress);
  const phase = (Math.PI * 2 * t) / 2.2;
  return {
    gather,
    offset: reducedMotion ? 0 : 0.85 * Math.sin(phase) * gather,
    stretch: reducedMotion ? 0 : Math.abs(Math.cos(phase)) * gather,
  };
}

// VoiceGlowStyle.lobes from the mobile renderer: position, width, height, band.
const MOBILE_LOBES = [
  [0, 74, 46, 0],
  [-36, 54, 40, 1],
  [36, 54, 40, 1],
  [-72, 48, 32, 2],
  [72, 48, 32, 2],
  [-108, 42, 26, 1],
  [108, 42, 26, 1],
] as const;

/** Mobile's overlapping lobes slide along x and fade at the wrap edge.
 * Use broad falloffs rather than outlining each syllable as a separate peak. */
export function mobileVoiceProfile(x: number, phase: number, bands: readonly number[]) {
  let light = 0;
  for (const [position, width, height, band] of MOBILE_LOBES) {
    const offset = ((((position / 252 + phase + 0.5) % 1) + 1) % 1) - 0.5;
    const edge = Math.max(0, 1 - (offset / 0.5) ** 2);
    const lift = 0.6 + 0.7 * (bands[band] ?? 0);
    const distance = (x - 0.5 - offset) / (width / 340);
    light += Math.exp(-0.5 * distance * distance) * (height / 46) * lift * edge;
  }
  return Math.min(1, light / 2.6);
}

/** VoiceGlowEngine.shape: mobile's noise gate and soft saturation. */
export function mobileVoiceLevel(raw: number) {
  const gated = Math.max(0, Math.min(1, (raw - 0.04) / 0.96));
  return (1 - Math.exp(-3 * gated)) / (1 - Math.exp(-3));
}

/** A tall mobile-style ceiling, concentrated in the middle of the desktop pill.
 * Keep the small resting ring independent of the much larger voiced crest. */
export type VoiceShape = {
  centre: number;
  width: number;
  split: number;
  separation: number;
  left: number;
  right: number;
};

const hash = (n: number) => {
  const value = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
};

const smoothNoise = (time: number, seed: number) => {
  const step = Math.floor(time);
  const fraction = time - step;
  const blend = fraction * fraction * (3 - 2 * fraction);
  return hash(step + seed) * (1 - blend) + hash(step + seed + 1) * blend;
};

/** Advance this clock with voiced energy. Spectral balance biases the changing
 * shoulders; variation freezes during silence rather than dancing on its own. */
export function voiceShape(time: number, level: number, bands: readonly number[]): VoiceShape {
  const low = bands[0] ?? level;
  const high = bands[2] ?? level;
  const balance = (high - low) / Math.max(0.1, high + low);
  return {
    centre: 0.5 + level * ((smoothNoise(time * 0.55, 31) - 0.5) * 0.23 + balance * 0.07),
    width: 0.8 + smoothNoise(time * 0.4, 17) * 0.38,
    split: Math.min(0.9, Math.max(0, (smoothNoise(time * 0.6, 71) - 0.3) / 0.65)) * level,
    separation: 0.065 + smoothNoise(time * 0.45, 43) * 0.085,
    left: Math.min(1, 0.5 + low * 0.35 + smoothNoise(time * 0.7, 59) * 0.2),
    right: Math.min(1, 0.5 + high * 0.35 + smoothNoise(time * 0.7, 83) * 0.2),
  };
}

export function voiceReach(x: number, profile: number, level = 1, shape?: VoiceShape) {
  const light = Math.max(0, Math.min(1, profile));
  const height = 48 * (0.35 + 4.65 * Math.max(0, Math.min(1, level)));
  let crest = centreBias(x) ** 1.45;
  if (shape) {
    const bell = centreBias(0.5 + (x - shape.centre) / shape.width) ** 1.45;
    const left = Math.exp(-0.5 * ((x - shape.centre + shape.separation) / 0.085) ** 2) * shape.left;
    const right =
      Math.exp(-0.5 * ((x - shape.centre - shape.separation) / 0.085) ** 2) * shape.right;
    const edge = Math.min(1, Math.max(0, Math.sin(Math.PI * x)) * 6);
    crest = Math.min(1, bell * (1 - shape.split) + Math.max(left, right) * shape.split) * edge;
  }
  return 3 + light * (2 + crest * height);
}

/** The lower shape saturates smoothly; even a shout cannot grow it past 14px.
 * Reserve the remaining gutter for the glow's feathered falloff. */
export function downwardReach(reach: number, available = 24) {
  const limit = Math.max(0, Math.min(14, available - 10));
  return limit * Math.tanh(Math.max(0, reach) / Math.max(1, limit));
}

export type SidePeak = { x: number; width: number; height: number };

/** Irregular, low side pulses. Each new position fades in from zero and back
 * out, so apparent randomness never becomes frame-to-frame flicker. */
export function voiceSidePeaks(
  elapsed: number,
  level: number,
  bands: readonly number[] = [1, 1, 1]
): SidePeak[] {
  return Array.from({ length: 12 }, (_, i) => {
    const time = Math.max(0, elapsed) / (1.1 + hash(i) * 1.8) + hash(i + 20);
    const cycle = Math.floor(time);
    const pulse = hash(i * 37 + cycle * 23) > 0.2 ? Math.sin(Math.PI * (time - cycle)) ** 2 : 0;
    const band = bands[(i + cycle) % 3] ?? level;
    return {
      x: (i < 6 ? 0.02 : 0.65) + hash(i * 19 + cycle * 11) * 0.33,
      width: 0.009 + hash(i * 13 + cycle * 29) * 0.036,
      height:
        Math.max(0, Math.min(1, level)) *
        (0.35 + band * 0.65) *
        (8 + hash(i + cycle * 7 + 100) * 36) *
        pulse,
    };
  });
}

export function sidePeakReach(x: number, peaks: readonly SidePeak[]) {
  let height = 0;
  for (const peak of peaks) {
    height += peak.height * Math.exp(-0.5 * ((x - peak.x) / peak.width) ** 2);
  }
  return Math.min(48, height) * Math.sin(Math.PI * Math.max(0, Math.min(1, x))) ** 0.5;
}

/** VoiceGlowBand.bell, with the mobile preset's curve, spread and skew. */
export function centreBias(x: number) {
  const t = 2 * Math.max(0, Math.min(1, x)) - 1;
  const sigma = 0.9 * (t < 0 ? 1 - 0.12 : 1 + 0.12);
  const tail = Math.exp(-((1 / sigma) ** 1.55));
  return Math.max(0, (Math.exp(-((Math.abs(t) / sigma) ** 1.55)) - tail) / (1 - tail));
}
