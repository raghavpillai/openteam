import { useEffect, useLayoutEffect, useRef } from "react";
import { getAudioContext } from "voice-glow";

const HALO_PADDING = 48;

/** Desktop halo: blur the light first, then punch out the entire bar. */
export function VoicePerimeterGlow({
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
    const buffer = new Float32Array(1024);
    let frame = 0;
    let previous = performance.now();
    let angle = 0;
    let level = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(64, now - previous);
      previous = now;
      const current = state.current;
      let target = current.processing ? 0.45 : 0;
      const meter = analyser.current;
      if (meter && !current.processing) {
        meter.getFloatTimeDomainData(buffer);
        let energy = 0;
        for (const sample of buffer) energy += sample * sample;
        target = Math.min(1, (Math.sqrt(energy / buffer.length) * 5) ** 0.7);
      }
      // Preserve the last voice level during exit; fade the whole halo in CSS.
      if (!current.exiting) {
        level += (target - level) * (1 - Math.exp(-dt / (target > level ? 65 : 260)));
      }
      // Integrate phase so switching into processing cannot jump the colors.
      if (!current.reducedMotion && !current.exiting) {
        angle = (angle + dt * (current.processing ? 0.00038 : 0.00012)) % (Math.PI * 2);
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
      if (element.height !== Math.round(height * ratio))
        element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const pillWidth = width - HALO_PADDING * 2;
      const pillHeight = height - HALO_PADDING * 2;
      if (pillWidth <= 0 || pillHeight <= 0) return;
      const outline = new Path2D();
      outline.roundRect(HALO_PADDING, HALO_PADDING, pillWidth, pillHeight, current.radius);
      const colors = context.createConicGradient(
        current.reducedMotion ? 0 : angle,
        width / 2,
        height / 2
      );
      colors.addColorStop(0, "#b184ff");
      colors.addColorStop(0.17, "#f49ccc");
      colors.addColorStop(0.34, "#ffbe8b");
      colors.addColorStop(0.5, "#80dfd0");
      colors.addColorStop(0.7, "#83bcff");
      colors.addColorStop(0.86, "#a493ff");
      colors.addColorStop(1, "#b184ff");
      context.strokeStyle = colors;
      const strength = current.dark ? 0.95 : 1;
      context.globalAlpha = (0.24 + level * 0.46) * strength;
      context.lineWidth = 8 + level * 12;
      context.filter = `blur(${10 + level * 5}px)`;
      context.stroke(outline);
      context.globalAlpha = (0.3 + level * 0.52) * strength;
      context.lineWidth = 3 + level * 5;
      context.filter = "blur(3.5px)";
      context.stroke(outline);
      // The single crisp contour stays subtle; the light lives outside it.
      context.globalAlpha = (0.2 + level * 0.3) * strength;
      context.lineWidth = 1;
      context.filter = "none";
      context.stroke(outline);
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
      className="vm-perimeter"
      data-voice-perimeter
      ref={canvas}
      tabIndex={-1}
    />
  );
}
