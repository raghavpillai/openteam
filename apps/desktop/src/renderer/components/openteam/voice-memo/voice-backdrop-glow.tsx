import { useEffect, useLayoutEffect, useRef } from "react";
import { getAudioContext } from "voice-glow";
import {
  downwardReach,
  mobileVoiceLevel,
  mobileVoiceProfile,
  processingSweep,
  sidePeakReach,
  voiceReach,
  voiceShape,
  voiceSidePeaks,
} from "./glow-motion";

// Give the ring a small lateral gutter; speech expands vertically. The drawing
// is additionally bounded by the sidebar's actual edge, without moving it.
const GLOW_PADDING = 336;
const BOTTOM_PADDING = 24;
const SIDE_PADDING = 12;

// Push the outer edge along the capsule's normals. The inner edge remains the
// original capsule, so a voice peak grows outward without bending the bar.
function glowRibbon(
  width: number,
  height: number,
  radius: number,
  outline: Path2D,
  spread: (x: number) => number,
  below: number
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
    const amount = spread(x / width);
    // Cap horizontal displacement independently of the tall vertical peaks.
    const px = SIDE_PADDING + x + nx * Math.min(3, amount * 0.1);
    const py = GLOW_PADDING + y + ny * (ny > 0 ? downwardReach(amount, below) : amount);
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
  path.addPath(outline);
  return path;
}

/** Horizontal voice motion with a rotating palette and a bounded centre swell. */
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
    let clipLeft = 0;
    let clipRight = width;
    let below = BOTTOM_PADDING;
    const sidebars = [...document.querySelectorAll<HTMLElement>("[data-sidebar]")];
    const measure = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      const bounds = element.getBoundingClientRect();
      const barBottom = bounds.bottom - BOTTOM_PADDING;
      below = Math.max(0, Math.min(BOTTOM_PADDING, window.innerHeight - barBottom - 2));
      clipLeft = Math.max(0, -bounds.left);
      clipRight = Math.min(width, window.innerWidth - bounds.left);
      for (const sidebar of sidebars) {
        const side = sidebar.getBoundingClientRect();
        if (!side.width || side.bottom <= bounds.top || side.top >= bounds.bottom) continue;
        if (side.right <= bounds.left + SIDE_PADDING + 0.5) {
          clipLeft = Math.max(clipLeft, side.right + 1 - bounds.left);
        } else if (side.left >= bounds.right - SIDE_PADDING - 0.5) {
          clipRight = Math.min(clipRight, side.left - 1 - bounds.left);
        }
      }
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    for (const sidebar of sidebars) resize.observe(sidebar);
    window.addEventListener("resize", measure);
    measure();
    const waveform = new Float32Array(1024);
    const frequencies = new Float32Array(512);
    let frame = 0;
    let previous = performance.now();
    let level = 0;
    let left = 0;
    let right = 0;
    let angle = 0;
    let flowPhase = 0;
    let elapsed = 0;
    let processingElapsed = 0;
    let exitElapsed = 0;
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
      processingElapsed = current.processing ? processingElapsed + dt / 1000 : 0;
      exitElapsed = current.exiting ? Math.min(1, exitElapsed + dt / 620) : 0;
      const retreat = 1 - exitElapsed * exitElapsed * (3 - 2 * exitElapsed);
      let target = current.processing ? 0.35 : 0;
      let low = target;
      let high = target;
      const meter = analyser.current;
      if (meter && !current.processing) {
        meter.getFloatTimeDomainData(waveform);
        let energy = 0;
        for (const sample of waveform) energy += sample * sample;
        target = mobileVoiceLevel(Math.min(1, (Math.sqrt(energy / waveform.length) * 5) ** 0.7));
        meter.getFloatFrequencyData(frequencies);
        low = bandLevel(meter, 80, 900);
        high = bandLevel(meter, 900, 6000);
      }
      // Mobile's live attack/release envelope and horizontal lobe flow.
      if (!current.exiting) {
        const follow = (value: number, next: number) =>
          value +
          (next - value) *
            (1 - Math.exp(-dt / (next > value ? (current.reducedMotion ? 120 : 80) : 300)));
        level = follow(level, target);
        left = follow(left, target * 0.6 + low * 0.4);
        right = follow(right, target * 0.6 + high * 0.4);
        if (!current.reducedMotion && !current.processing) {
          // Mobile flow / lobe span: 60 / (252 * 1.35), normalised to the bar.
          flowPhase = (flowPhase + ((60 / 340.2) * level * dt) / 1000) % 1;
        }
      }
      // Integrate phase across mode changes; only the palette turns, never the
      // canvas or bar. Reduced Motion keeps its current palette stationary.
      if (!current.reducedMotion && !current.exiting) {
        angle = (angle + dt * 0.00018) % (Math.PI * 2);
        // Random-looking variation advances with speech, and rests in silence.
        elapsed += (dt / 1000) * level;
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
      if (element.height !== Math.round(height * ratio))
        element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const barWidth = width - SIDE_PADDING * 2;
      const barHeight = height - GLOW_PADDING - BOTTOM_PADDING;
      if (barWidth <= 0 || barHeight <= 0) return;
      const outline = new Path2D();
      outline.roundRect(SIDE_PADDING, GLOW_PADDING, barWidth, barHeight, current.radius);
      const colors = context.createConicGradient(angle, width / 2, GLOW_PADDING + barHeight / 2);
      colors.addColorStop(0, "#aa8cff");
      colors.addColorStop(0.17, "#f694c8");
      colors.addColorStop(0.34, "#ffc394");
      colors.addColorStop(0.5, "#82dfce");
      colors.addColorStop(0.7, "#85bbff");
      colors.addColorStop(0.86, "#b0a0ff");
      colors.addColorStop(1, "#aa8cff");
      const strength = current.dark ? 0.68 : 1.75;
      // A continuous luminous ring leads the effect. Voice adds a little width
      // and brightness without turning its silhouette into a row of spikes.
      context.strokeStyle = colors;
      context.globalAlpha = (0.18 + level * 0.04) * strength * retreat;
      context.lineWidth = 18 + level * 3;
      context.filter = "blur(9px)";
      context.stroke(outline);
      context.globalAlpha = Math.min(1, (0.52 + level * 0.12) * strength * retreat);
      context.lineWidth = 10 + level * 2;
      context.filter = "blur(4px)";
      context.stroke(outline);
      const sweep = processingSweep(processingElapsed, current.reducedMotion);
      const bands = [left, level, right];
      const sidePeaks = voiceSidePeaks(elapsed, level * (1 - sweep.gather), bands);
      const shape = voiceShape(elapsed, level, bands);
      const localPeak = (x: number) => {
        const voice = mobileVoiceProfile(x, flowPhase, bands);
        const centre = (1 + sweep.offset) / 2;
        const beamWidth = 0.075 + sweep.stretch * 0.055;
        const beam = Math.exp(-0.5 * ((x - centre) / beamWidth) ** 2);
        return voice * (1 - sweep.gather) + beam * sweep.gather * 0.8;
      };
      context.fillStyle = colors;
      // Build a continuous falloff from several translucent blooms, broad and
      // faint outside, narrower and brighter near the bar. A single opaque
      // ribbon with a small blur looks like inflated tubing rather than light.
      for (let layer = 0; layer < 6; layer++) {
        const scale = 1.2 - layer * 0.18;
        context.globalAlpha = (0.035 + layer * 0.025) * (1 + level * 0.25) * strength * retreat;
        context.filter = `blur(${24 - layer * 2.8}px)`;
        context.fill(
          glowRibbon(
            barWidth,
            barHeight,
            current.radius,
            outline,
            (x) =>
              (voiceReach(x, localPeak(x), level, current.processing ? undefined : shape) +
                sidePeakReach(x, sidePeaks)) *
              scale *
              retreat,
            below
          ),
          "evenodd"
        );
      }
      context.filter = "none";
      // Punch out the bar after drawing the bloom, keeping the input clear even
      // while its opaque surface and controls morph into place above this layer.
      context.globalCompositeOperation = "destination-out";
      context.globalAlpha = 1;
      context.fill(outline);
      // Feather within the canvas, rather than hiding spill behind another UI.
      context.globalCompositeOperation = "destination-in";
      const edgeFade = context.createLinearGradient(
        clipLeft,
        0,
        Math.max(clipLeft + 1, clipRight),
        0
      );
      const feather = Math.min(0.1, 12 / Math.max(1, clipRight - clipLeft));
      edgeFade.addColorStop(0, "transparent");
      edgeFade.addColorStop(feather, "black");
      edgeFade.addColorStop(1 - feather, "black");
      edgeFade.addColorStop(1, "transparent");
      context.fillStyle = edgeFade;
      context.fillRect(0, 0, width, height);
      // Fade after blurring so the soft halo reaches zero before the window
      // edge, instead of being chopped off there.
      const barBottom = GLOW_PADDING + barHeight;
      const fadeRoom = Math.max(0, below - 2);
      if (fadeRoom > 0) {
        const bottomFade = context.createLinearGradient(0, barBottom, 0, barBottom + fadeRoom);
        bottomFade.addColorStop(0, "black");
        bottomFade.addColorStop(0.15, "black");
        bottomFade.addColorStop(0.6, "rgba(0, 0, 0, 0.32)");
        bottomFade.addColorStop(0.85, "rgba(0, 0, 0, 0.04)");
        bottomFade.addColorStop(1, "transparent");
        context.fillStyle = bottomFade;
        context.fillRect(0, 0, width, height);
      } else {
        context.clearRect(0, barBottom, width, height - barBottom);
      }
      context.globalCompositeOperation = "source-over";
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", measure);
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
