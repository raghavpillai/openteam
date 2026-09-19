// The reference's layout/pin spring: mass 1, stiffness 1000, damping 63.
const decay = 63 / 2;
const frequency = Math.sqrt(1_000 - decay * decay);
export function sidebarSpring(displacement: number, velocity: number, ms: number) {
  const t = Math.max(0, ms) / 1_000;
  const b = (velocity + decay * displacement) / frequency;
  const sin = Math.sin(frequency * t),
    cos = Math.cos(frequency * t);
  const envelope = Math.exp(-decay * t);
  const value = envelope * (displacement * cos + b * sin);
  const speed =
    envelope *
    ((b * frequency - decay * displacement) * cos - (displacement * frequency + decay * b) * sin);
  return { value, velocity: speed };
}
export function sidebarSpringFrames(x: number, y: number, vx = 0, vy = 0) {
  const frames: Keyframe[] = [];
  let duration = 0;
  for (let ms = 0; ms <= 2_000; ms += 1000 / 120) {
    const sx = sidebarSpring(x, vx, ms),
      sy = sidebarSpring(y, vy, ms);
    frames.push({ translate: `${sx.value}px ${sy.value}px` });
    duration = ms;
    if (
      ms > 0 &&
      Math.abs(sx.value) < 0.01 &&
      Math.abs(sy.value) < 0.01 &&
      Math.abs(sx.velocity) < 0.1 &&
      Math.abs(sy.velocity) < 0.1
    )
      break;
  }
  frames.push({ translate: "0px 0px" });
  return { frames, duration: duration + 1000 / 120 };
}
export function pinnedSpringFrames(exiting: boolean, from = exiting ? 1 : 0) {
  const frames: Keyframe[] = [];
  const duration = 400;
  for (let ms = 0; ms <= duration; ms += 1000 / 120) {
    const progress = 1 - sidebarSpring(1, 0, ms).value;
    const visibility = from + ((exiting ? 0 : 1) - from) * progress;
    frames.push({ opacity: visibility, scale: 0.85 + 0.15 * visibility });
  }
  frames.push({ opacity: exiting ? 0 : 1, scale: exiting ? 0.85 : 1 });
  return { frames, duration };
}
