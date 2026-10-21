import { useEffect, useLayoutEffect, useRef } from "react";
import { getAudioContext } from "voice-glow";

const GLOW_PADDING = 64;
const REGIONS = 20;
const ENVELOPE_MS = 50;

// Push the outer edge along the capsule's normals. The inner edge remains the
// original capsule, so a voice peak grows outward without bending the bar.
function glowRibbon(
  width: number,
  height: number,
  radius: number,
  outline: Path2D,
  spread: (position: number) => number
) {
  const r = Math.min(radius, width / 2, height / 2);
  const straight = width - r * 2;
  const arc = Math.PI * r;
  const perimeter = straight * 2 + arc * 2;
  const steps = Math.max(96, Math.ceil(perimeter / 6));
  const path = new Path2D();
  for (let i = 0; i <= steps; i++) {
    const position = i / steps;
    const distance = position * perimeter;
    let x: number;
    let y: number;
    let nx = 0;
    let ny = 0;
    if (distance < straight) {
      x = r + distance;
      y = 0;
      ny = -1;
    } else if (distance < straight + arc) {
      const angle = -Math.PI / 2 + (distance - straight) / r;
      nx = Math.cos(angle);
      ny = Math.sin(angle);
      x = width - r + nx * r;
      y = r + ny * r;
    } else if (distance < straight * 2 + arc) {
      x = width - r - (distance - straight - arc);
      y = height;
      ny = 1;
    } else {
      const angle = Math.PI / 2 + (distance - straight * 2 - arc) / r;
      nx = Math.cos(angle);
      ny = Math.sin(angle);
      x = r + nx * r;
      y = r + ny * r;
    }
    const amount = spread(position);
    const px = GLOW_PADDING + x + nx * amount;
    const py = GLOW_PADDING + y + ny * amount;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
  path.addPath(outline);
  return path;
}

/** A continuous rotating bloom, with brighter regions shaped by the voice. */
export function VoiceBackdropGlow({
  stream,
  processing,
  exiting,
  radius,
  dark,
  reducedMotion,
}: {
  stream: MediaStream | null;
  processing: boolean;
  exiting: boolean;
  radius: number;
  dark: boolean;
  reducedMotion: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const state = useRef({ processing, exiting, radius, dark, reducedMotion });
  useLayoutEffect(() => {
    state.current = { processing, exiting, radius, dark, reducedMotion };
  }, [processing, exiting, radius, dark, reducedMotion]);

  useEffect(() => {
    if (!stream) return;
    let source: MediaStreamAudioSourceNode | undefined;
    let tap: MediaStream | undefined;
    let meter: AnalyserNode | undefined;
    try {
      const track = stream.getAudioTracks()[0];
      if (!track) return;
      const audio = getAudioContext();
      if (!audio) return;
      tap = new MediaStream([track.clone()]);
      source = audio.createMediaStreamSource(tap);
      meter = audio.createAnalyser();
      meter.fftSize = 1024;
      source.connect(meter);
      analyser.current = meter;
    } catch {
      // Decorative audio analysis must never interrupt a recording.
    }
    return () => {
      if (analyser.current === meter) analyser.current = null;
      source?.disconnect();
      meter?.disconnect();
      for (const track of tap?.getTracks() ?? []) track.stop();
    };
  }, [stream]);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    let width = element.clientWidth;
    let height = element.clientHeight;
    const resize = new ResizeObserver(() => {
      width = element.clientWidth;
      height = element.clientHeight;
    });
    resize.observe(element);
    const waveform = new Float32Array(1024);
    const frequencies = new Float32Array(512);
    let frame = 0;
    let previous = performance.now();
    let level = 0;
    let left = 0;
    let right = 0;
    let angle = 0;
    let sampleElapsed = 0;
    let peak = 0;
    const history: number[] = Array(REGIONS * 3).fill(0);
    const regions = new Float32Array(REGIONS);
    const bandLevel = (meter: AnalyserNode, from: number, to: number) => {
      const binHz = meter.context.sampleRate / meter.fftSize;
      let power = 0;
      for (let i = Math.ceil(from / binHz); i <= Math.floor(to / binHz); i++) {
        const db = frequencies[i] ?? -Infinity;
        power += 10 ** (db / 10);
      }
      return Math.min(1, (Math.sqrt(power) * 12) ** 0.7);
    };
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(64, now - previous);
      previous = now;
      const current = state.current;
      let target = current.processing ? 0.35 : 0;
      let low = target;
      let high = target;
      const meter = analyser.current;
      if (meter && !current.processing) {
        meter.getFloatTimeDomainData(waveform);
        let energy = 0;
        for (const sample of waveform) energy += sample * sample;
        target = Math.min(1, (Math.sqrt(energy / waveform.length) * 5) ** 0.7);
        meter.getFloatFrequencyData(frequencies);
        low = bandLevel(meter, 80, 900);
        high = bandLevel(meter, 900, 6000);
      }
      // Keep recent syllables rather than applying one averaged volume to the
      // entire outline. Adjacent regions follow peaks 150ms apart.
      if (!current.exiting) {
        const follow = (value: number, next: number) =>
          value +
          (next - value) *
            (1 - Math.exp(-dt / (next > value ? (current.reducedMotion ? 120 : 65) : 280)));
        level = follow(level, target);
        left = follow(left, target * 0.6 + low * 0.4);
        right = follow(right, target * 0.6 + high * 0.4);
        if (!current.processing) {
          peak = Math.max(peak, target);
          sampleElapsed += dt;
          if (sampleElapsed >= ENVELOPE_MS) {
            sampleElapsed %= ENVELOPE_MS;
            history.pop();
            history.unshift(peak);
            peak = target;
          }
        }
        for (let i = 0; i < REGIONS; i++) {
          const next = current.processing ? target : (history[i * 3] ?? 0);
          const value = regions[i] ?? 0;
          regions[i] = value + (next - value) * (1 - Math.exp(-dt / 55));
        }
      }
      // Integrate phase across mode changes; only the palette turns, never the
      // canvas or bar. Reduced Motion keeps its current palette stationary.
      if (!current.reducedMotion && !current.exiting) {
        angle = (angle + dt * 0.00035) % (Math.PI * 2);
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
      if (element.height !== Math.round(height * ratio))
        element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const barWidth = width - GLOW_PADDING * 2;
      const barHeight = height - GLOW_PADDING * 2;
      if (barWidth <= 0 || barHeight <= 0) return;
      const outline = new Path2D();
      outline.roundRect(GLOW_PADDING, GLOW_PADDING, barWidth, barHeight, current.radius);
      const colors = context.createConicGradient(angle, width / 2, height / 2);
      colors.addColorStop(0, "#a46aff");
      colors.addColorStop(0.17, "#f47ac5");
      colors.addColorStop(0.34, "#ffaf75");
      colors.addColorStop(0.5, "#5fe0c5");
      colors.addColorStop(0.7, "#65b0ff");
      colors.addColorStop(0.86, "#9a80ff");
      colors.addColorStop(1, "#a46aff");
      const strength = current.dark ? 0.9 : 1;
      // Keep a small continuous base; a large uniform bloom would fill in all
      // the valleys and hide the voice-shaped silhouette above it.
      context.strokeStyle = colors;
      context.globalAlpha = 0.55 * strength;
      context.lineWidth = 12;
      context.filter = "blur(9px)";
      context.stroke(outline);
      const localPeak = (position: number) => {
        if (current.reducedMotion) return level * 0.45;
        const index = position * REGIONS;
        const first = Math.floor(index) % REGIONS;
        const fraction = index - Math.floor(index);
        const blend = (1 - Math.cos(fraction * Math.PI)) / 2;
        const envelope =
          (regions[first] ?? 0) * (1 - blend) + (regions[(first + 1) % REGIONS] ?? 0) * blend;
        const side = (1 - Math.cos(position * Math.PI * 2)) / 2;
        const band = left * (1 - side) + right * side;
        return Math.min(1, envelope * 1.4) ** 2.2 * (0.75 + band * 0.25);
      };
      context.fillStyle = colors;
      context.globalAlpha = (0.78 + level * 0.18) * strength;
      context.filter = "blur(5px)";
      context.fill(
        glowRibbon(barWidth, barHeight, current.radius, outline, (t) => 8 + localPeak(t) * 42),
        "evenodd"
      );
      context.globalAlpha = (0.55 + level * 0.3) * strength;
      context.filter = "blur(4px)";
      context.fill(
        glowRibbon(barWidth, barHeight, current.radius, outline, (t) => 2 + localPeak(t) * 20),
        "evenodd"
      );
      context.filter = "none";
      // Punch out the bar after drawing the bloom, keeping the input clear even
      // while its opaque surface and controls morph into place above this layer.
      context.globalCompositeOperation = "destination-out";
      context.globalAlpha = 1;
      context.fill(outline);
      context.globalCompositeOperation = "source-over";
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, []);

  return (
    <canvas
      aria-hidden="true"
      className="vm-backdrop-glow"
      data-voice-glow
      ref={canvas}
      tabIndex={-1}
    />
  );
}
