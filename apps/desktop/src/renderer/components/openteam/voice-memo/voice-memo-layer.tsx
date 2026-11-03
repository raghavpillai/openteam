// The composer while a voice note records or transcribes: one bar with the
// time, the voice as it's heard, discard and send, over a voice-reactive glow.
// Loaded on demand so the glow stays out of startup.
import { Trash2 } from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { getAudioContext } from "voice-glow";
import { BotArrowUpIcon, BotCloseIcon, BotPlusIcon } from "../../ai-elements/composer-icons";
import { LoadingOrb, preloadLoadingOrb } from "../../ui/loading-orb";
import { VoiceBackdropGlow } from "./voice-backdrop-glow";
import "./voice-memo.css";

export type VoiceMemoMode = "recording" | "processing";

export interface VoiceMemoLayerProps {
  mode: VoiceMemoMode;
  /** The last mode, kept on screen while the layer animates away. */
  exiting?: boolean;
  stream: MediaStream | null;
  elapsedMs: number;
  radius: number;
  /** Centre of the mic that started recording, from the composer's bottom-right. */
  anchor: { right: number; bottom: number };
  onDiscard: () => void;
  onSend: () => void;
  onCancelProcessing: () => void;
}

const WAVE_SAMPLE_MS = 50;
const WAVE_STEP_PX = 4;
const formatDuration = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const readDocumentDark = () => document.documentElement.dataset.theme === "dark";

function useDocumentDark() {
  const [dark, setDark] = useState(readDocumentDark);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(readDocumentDark()));
    observer.observe(document.documentElement, { attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

// The voice across the bar: a dotted baseline the take scrolls over
// continuously, newest sound entering at the right edge.
function VoiceWave({ stream }: { stream: MediaStream | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let tap: MediaStream | undefined;
    try {
      const audio = stream ? getAudioContext() : null;
      const track = stream?.getAudioTracks()[0];
      if (audio && track) {
        // The bars listen to their own clone of the track the glow reads.
        tap = new MediaStream([track.clone()]);
        source = audio.createMediaStreamSource(tap);
        analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
      }
    } catch {
      // The bars are decoration; the recording itself doesn't depend on them.
    }
    const buffer = new Float32Array(1024);
    const samples: number[] = [];
    let level = 0;
    let peak = 0;
    let frame = 0;
    let lastSample = performance.now();
    // Size and ink change rarely; reading them every frame would force style and layout.
    let width = element.clientWidth;
    let height = element.clientHeight;
    let ink = getComputedStyle(element).color;
    const resize = new ResizeObserver(() => {
      width = element.clientWidth;
      height = element.clientHeight;
    });
    resize.observe(element);
    const theme = new MutationObserver(() => {
      ink = getComputedStyle(element).color;
    });
    theme.observe(document.documentElement, { attributeFilter: ["data-theme", "class"] });
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (analyser) {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) sum += value * value;
        const target = Math.min(1, (Math.sqrt(sum / buffer.length) * 5) ** 0.7);
        // Quick to rise, slower to fall, so bars don't flicker.
        level += (target - level) * (target > level ? 0.45 : 0.12);
        peak = Math.max(peak, level);
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
      if (element.height !== Math.round(height * ratio))
        element.height = Math.round(height * ratio);
      const capacity = Math.ceil(width / WAVE_STEP_PX) + 2;
      while (now - lastSample >= WAVE_SAMPLE_MS) {
        lastSample += WAVE_SAMPLE_MS;
        samples.push(peak);
        peak = level;
        if (samples.length > capacity) samples.splice(0, samples.length - capacity);
      }
      // Sub-step scroll between samples keeps the motion continuous.
      const progress = Math.min(1, (now - lastSample) / WAVE_SAMPLE_MS);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = ink;
      for (let slot = 0; slot < capacity; slot++) {
        const x = width - (slot + progress) * WAVE_STEP_PX;
        if (x < -2) break;
        const index = samples.length - 1 - slot;
        const value = samples[index] ?? 0;
        // The newest bar grows in rather than popping.
        const grown = slot === 0 ? value * progress : value;
        const bar = Math.max(2, grown * (height - 2));
        const fade = Math.min(1, x / 16);
        context.globalAlpha = (index >= 0 ? 1 : 0.4) * Math.max(0, fade);
        context.beginPath();
        context.roundRect(x, (height - bar) / 2, 2, bar, 1);
        context.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      source?.disconnect();
      analyser?.disconnect();
      for (const clone of tap?.getTracks() ?? []) clone.stop();
    };
  }, [stream]);
  return (
    <canvas aria-hidden="true" className="vm-wave" data-voice-wave ref={canvas} tabIndex={-1} />
  );
}

// The attachment button turns to liquid and flows into the time chip: a
// droplet runs ahead and the pill stretches to swallow it (SVG goo under
// crisp text, so the time never blurs).
function TimeChip({
  elapsedMs,
  gooId,
  processing,
}: {
  elapsedMs: number;
  gooId: string;
  processing: boolean;
}) {
  return (
    <span className="vm-chip">
      <svg aria-hidden="true" className="vm-goo" height="44" width="96" viewBox="-8 -8 96 44">
        <defs>
          <filter height="200%" id={gooId} width="200%" x="-50%" y="-50%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
            <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
          </filter>
        </defs>
        <g filter={`url(#${gooId})`}>
          <g className="vm-chip-liquid">
            <rect className="vm-goo-pill" height="28" rx="14" width="60" x="0" y="0" />
            <circle className="vm-goo-drop" cx="14" cy="14" r="9" />
          </g>
        </g>
      </svg>
      <span aria-hidden="true" className="vm-chip-plus">
        <BotPlusIcon className="size-3.5" />
      </span>
      <span aria-hidden={processing} className="vm-chip-time">
        {formatDuration(elapsedMs)}
      </span>
      <span aria-hidden="true" className="vm-chip-orb">
        {processing ? <LoadingOrb label="Transcribing" size={20} /> : null}
      </span>
    </span>
  );
}

export default function VoiceMemoLayer({
  mode,
  exiting = false,
  stream,
  elapsedMs,
  radius,
  anchor,
  onDiscard,
  onSend,
  onCancelProcessing,
}: VoiceMemoLayerProps) {
  const dark = useDocumentDark();
  const reducedMotion = useReducedMotion();
  const gooId = `vm-goo-${useId().replace(/:/g, "")}`;
  useEffect(() => void preloadLoadingOrb(), []);
  return (
    <div
      className="vm-root"
      data-exiting={exiting ? "" : undefined}
      data-voice-memo={mode}
      style={
        {
          "--vm-radius": `${radius}px`,
          "--vm-anchor-right": `${anchor.right}px`,
          "--vm-anchor-bottom": `${anchor.bottom}px`,
        } as CSSProperties
      }
    >
      <VoiceBackdropGlow
        dark={dark}
        exiting={exiting}
        processing={mode === "processing"}
        radius={radius}
        reducedMotion={reducedMotion}
        stream={mode === "recording" ? stream : null}
      />
      <div aria-hidden="true" className="vm-reveal">
        <div className="vm-surface-liquid" style={{ filter: `url(#${gooId})` }}>
          <span className="vm-surface-pill" />
          <span className="vm-surface-drop" />
        </div>
      </div>

      <div className="vm-bar">
        <TimeChip elapsedMs={elapsedMs} gooId={gooId} processing={mode === "processing"} />
        <span className="vm-body">
          <span className="vm-wave-slot">
            <VoiceWave stream={stream} />
          </span>
          <span aria-hidden="true" className="vm-processing">
            Transcribing…
          </span>
        </span>
        <span className="vm-actions">
          {/* Only the backplates go through the liquid filter. Icons and hit
              targets stay crisp and stationary while the droplets separate. */}
          <svg
            aria-hidden="true"
            className="vm-action-goo"
            height="44"
            viewBox="-8 -8 80 44"
            width="80"
          >
            <g filter={`url(#${gooId})`}>
              <g className="vm-discard-drop">
                <circle cx="14" cy="14" r="14" />
              </g>
              <circle className="vm-send-drop" cx="50" cy="14" r="14" />
            </g>
          </svg>
          <button
            aria-hidden={mode !== "recording" || exiting}
            aria-label="Discard voice note"
            className="vm-icon-button vm-discard"
            disabled={mode !== "recording" || exiting}
            onClick={onDiscard}
            tabIndex={mode !== "recording" || exiting ? -1 : undefined}
            title="Discard · Esc"
            type="button"
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            aria-hidden={exiting}
            aria-label={mode === "recording" ? "Send voice note" : "Cancel voice note"}
            className="vm-send"
            disabled={exiting}
            onClick={mode === "recording" ? onSend : onCancelProcessing}
            tabIndex={exiting ? -1 : undefined}
            title={mode === "recording" ? "Send" : "Cancel · Esc"}
            type="button"
          >
            <span className="vm-send-icon">
              <BotArrowUpIcon className="size-3.5" />
            </span>
            <span className="vm-cancel-icon">
              <BotCloseIcon className="size-3" />
            </span>
          </button>
        </span>
      </div>
      <span aria-live="polite" className="sr-only" role="status">
        {exiting
          ? ""
          : mode === "recording"
            ? "Recording voice note. Send or discard when you're done."
            : "Transcribing voice note…"}
      </span>
    </div>
  );
}
