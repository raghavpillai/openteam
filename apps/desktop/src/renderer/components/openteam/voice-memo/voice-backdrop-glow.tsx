import { useEffect, useLayoutEffect, useRef } from "react";
import { getAudioContext } from "voice-glow";

const GLOW_PADDING = 64;

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
      // Vocal body and articulation swell different parts of the backdrop.
      // Both sit over a continuous bloom so the entire bar always stays lit.
      if (!current.exiting) {
        const follow = (value: number, next: number) =>
          value +
          (next - value) *
            (1 - Math.exp(-dt / (next > value ? (current.reducedMotion ? 120 : 65) : 280)));
        level = follow(level, target);
        left = follow(left, target * 0.6 + low * 0.4);
        right = follow(right, target * 0.6 + high * 0.4);
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
      // A broad wash plus a softer near-edge bloom lights every part of the
      // capsule, including its ends. Neither pass draws a crisp second border.
      context.strokeStyle = colors;
      context.globalAlpha = (0.6 + level * 0.4) * strength;
      context.lineWidth = 22 + level * 24;
      context.filter = `blur(${12 + level * 5}px)`;
      context.stroke(outline);
      context.globalAlpha = (0.5 + level * 0.4) * strength;
      context.lineWidth = 8 + level * 10;
      context.filter = "blur(5px)";
      context.stroke(outline);
      context.filter = "none";
      const spreadX = Math.min(barWidth * 0.48, barWidth * 0.27 + GLOW_PADDING - 8);
      const cloud = (position: number, activity: number, hue: number) => {
        context.save();
        context.translate(GLOW_PADDING + barWidth * position, height / 2);
        context.scale(spreadX, barHeight / 2 + 38 + activity * 24);
        const color = (alpha: number) => `hsl(${hue} 95% ${current.dark ? 64 : 67}% / ${alpha})`;
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        gradient.addColorStop(0, color(1));
        gradient.addColorStop(0.35, color(0.7));
        gradient.addColorStop(0.7, color(0.2));
        gradient.addColorStop(0.85, color(0.04));
        // Keep the hue at zero alpha so the bloom never fades through black.
        gradient.addColorStop(1, color(0));
        context.globalAlpha = (0.32 + activity * 0.6 + level * 0.08) * strength;
        context.fillStyle = gradient;
        context.fillRect(-1, -1, 2, 2);
        context.restore();
      };
      const rotation = (angle * 180) / Math.PI;
      cloud(0.2, left, 240 + rotation + left * 35);
      cloud(0.5, level, 285 + rotation + level * 25);
      cloud(0.8, right, 325 + rotation + right * 35);
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
