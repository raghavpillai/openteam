// The composer while a voice note records or transcribes: one bar with the
// time, the voice as it's heard, discard and send, over a voice-reactive glow.
// Loaded on demand so the glow stays out of startup.
import { Trash2 } from "lucide-react";
import {
  Component,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { getAudioContext, VoiceBeam, type VoiceBeamMotion } from "voice-glow";
import { BotArrowUpIcon, BotCloseIcon, BotPlusIcon } from "../../ai-elements/composer-icons";
import { LoadingOrb, preloadLoadingOrb } from "../../ui/loading-orb";
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
const SWEEP_MS = 1500;
const GATHER_MS = 420;

const easeInOut = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;
const formatDuration = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function useDocumentDark() {
  const read = () => document.documentElement.dataset.theme === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

// The glow is decoration: if audio analysis fails, the bar keeps working.
class GlowBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
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
        const target = Math.min(1, Math.pow(Math.sqrt(sum / buffer.length) * 5, 0.7));
        // Quick to rise, slower to fall, so bars don't flicker.
        level += (target - level) * (target > level ? 0.45 : 0.12);
        peak = Math.max(peak, level);
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
      if (element.height !== Math.round(height * ratio)) element.height = Math.round(height * ratio);
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
        const value = index >= 0 ? samples[index]! : 0;
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
  return <canvas aria-hidden="true" className="vm-wave" data-voice-wave ref={canvas} />;
}

// The attachment button turns to liquid and flows into the time chip: a
// droplet runs ahead and the pill stretches to swallow it (SVG goo under
// crisp text, so the time never blurs).
function TimeChip({ elapsedMs, gooId }: { elapsedMs: number; gooId: string }) {
  return (
    <span className="vm-chip">
      <svg aria-hidden="true" className="vm-goo" height="44" width="96" viewBox="-8 -8 96 44">
        <defs>
          <filter id={gooId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
            <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
          </filter>
        </defs>
        <g filter={`url(#${gooId})`}>
          <rect className="vm-goo-pill" height="28" rx="14" width="28" x="0" y="0" />
          <circle className="vm-goo-drop" cx="14" cy="14" r="9" />
        </g>
      </svg>
      <span aria-hidden="true" className="vm-chip-plus">
        <BotPlusIcon className="size-3.5" />
      </span>
      <span className="vm-chip-time">{formatDuration(elapsedMs)}</span>
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
  const gooId = `vm-goo-${useId().replace(/:/g, "")}`;
  useEffect(() => void preloadLoadingOrb(), []);
  const processingSince = useRef<number | null>(null);
  useLayoutEffect(() => {
    processingSince.current = mode === "processing" && !exiting ? performance.now() : null;
  }, [mode, exiting]);

  // While transcribing, the glow gathers into one beam that sweeps side to side.
  const motion = (): VoiceBeamMotion => {
    const since = processingSince.current;
    if (since === null) return { gather: 0 };
    const elapsed = performance.now() - since;
    const phase = (elapsed % (SWEEP_MS * 2)) / SWEEP_MS;
    const sweep = phase <= 1 ? easeInOut(phase) : 1 - easeInOut(phase - 1);
    return {
      gather: easeInOut(Math.min(1, elapsed / GATHER_MS)),
      offset: (sweep * 2 - 1) * 0.55,
      stretch: 0.35,
      heldLevel: 0.55,
    };
  };

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
      <div aria-hidden="true" className="vm-reveal" />
      <div aria-hidden="true" className="vm-beam">
        <GlowBoundary>
          <VoiceBeam
            active={!exiting}
            borderRadius={radius}
            motion={motion}
            stream={mode === "recording" ? stream : null}
            style={{ position: "absolute", inset: 0 }}
            theme={dark ? "dark" : "light"}
          >
            <div style={{ width: "100%", height: "100%", borderRadius: radius }} />
          </VoiceBeam>
        </GlowBoundary>
      </div>

      <div className="vm-bar" key={mode}>
        {mode === "recording" ? (
          <>
            <TimeChip elapsedMs={elapsedMs} gooId={gooId} />
            <span className="vm-wave-slot vm-item" style={{ "--i": 1 } as CSSProperties}>
              <VoiceWave stream={stream} />
            </span>
            <button
              aria-label="Discard voice note"
              className="vm-icon-button vm-item"
              onClick={onDiscard}
              style={{ "--i": 2 } as CSSProperties}
              title="Discard · Esc"
              type="button"
            >
              <Trash2 className="size-3.5" />
            </button>
            <button
              aria-label="Send voice note"
              className="vm-send vm-item"
              onClick={onSend}
              style={{ "--i": 3 } as CSSProperties}
              title="Send"
              type="button"
            >
              <BotArrowUpIcon className="size-3.5" />
            </button>
          </>
        ) : (
          <>
            <span className="vm-processing vm-item" style={{ "--i": 0 } as CSSProperties}>
              <LoadingOrb label="Transcribing" size={20} />
              Transcribing…
            </span>
            <span className="vm-spacer" />
            <button
              aria-label="Cancel voice note"
              className="vm-icon-button vm-item"
              onClick={onCancelProcessing}
              style={{ "--i": 1 } as CSSProperties}
              title="Cancel · Esc"
              type="button"
            >
              <BotCloseIcon className="size-3" />
            </button>
          </>
        )}
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
