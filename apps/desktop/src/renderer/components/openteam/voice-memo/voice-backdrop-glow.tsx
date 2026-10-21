import { useEffect, useLayoutEffect, useRef } from "react";
import { getAudioContext } from "voice-glow";

const GLOW_PADDING = 48;

/** Two stationary washes of light behind the bar; audio alone changes their color. */
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
      // Volume drives both sides; vocal body and articulation change their hues
      // independently. There is no clock-driven phase, travel, or color rotation.
      if (!current.exiting) {
        const follow = (value: number, next: number) =>
          value +
          (next - value) *
            (1 - Math.exp(-dt / (next > value ? (current.reducedMotion ? 120 : 65) : 280)));
        level = follow(level, target);
        left = follow(left, target * 0.6 + low * 0.4);
        right = follow(right, target * 0.6 + high * 0.4);
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
      // Keep both centers fixed. Only color, opacity and the soft spread respond.
      const spreadX = Math.min(barWidth * 0.45, barWidth * 0.25 + GLOW_PADDING - 8);
      const cloud = (position: number, activity: number, hue: number) => {
        context.save();
        context.translate(GLOW_PADDING + barWidth * position, height / 2);
        context.scale(spreadX, barHeight / 2 + 24 + activity * 16);
        const color = (alpha: number) => `hsl(${hue} 95% ${current.dark ? 64 : 67}% / ${alpha})`;
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        gradient.addColorStop(0, color(1));
        gradient.addColorStop(0.35, color(0.7));
        gradient.addColorStop(0.7, color(0.2));
        gradient.addColorStop(0.85, color(0.04));
        // Keep the hue at zero alpha so the bloom never fades through black.
        gradient.addColorStop(1, color(0));
        context.globalAlpha = (0.28 + activity * 0.6 + level * 0.12) * (current.dark ? 0.9 : 1);
        context.fillStyle = gradient;
        context.fillRect(-1, -1, 2, 2);
        context.restore();
      };
      cloud(0.25, left, 210 + left * 90);
      cloud(0.75, right, 280 + right * 100);
      // Punch out the bar after drawing the bloom, keeping the input clear even
      // while its opaque surface and controls morph into place above this layer.
      context.globalCompositeOperation = "destination-out";
      context.globalAlpha = 1;
      context.beginPath();
      context.roundRect(GLOW_PADDING, GLOW_PADDING, barWidth, barHeight, current.radius);
      context.fill();
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
