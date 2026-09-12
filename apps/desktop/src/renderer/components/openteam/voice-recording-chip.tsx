import { useEffect, useRef } from "react";

// Grok Bot 0.47 recording chip: 28px pill, 10px stop square, 18×13px spectrum.
export function VoiceRecordingChip({
  elapsedMs,
  stream,
  onStop,
}: {
  elapsedMs: number;
  stream: MediaStream | null;
  onStop: () => void;
}) {
  const duration = `${Math.floor(elapsedMs / 60_000)}:${String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0")}`;
  return (
    <button
      aria-label="Stop recording"
      title="Stop dictation · Esc to cancel"
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-[rgba(20,20,20,0.08)] px-2.5 py-1 text-[#141414] outline-none transition-colors duration-[120ms] hover:bg-[rgba(20,20,20,0.14)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring dark:bg-[rgba(240,240,240,0.08)] dark:text-[#f0f0f0] dark:hover:bg-[rgba(240,240,240,0.14)]"
      data-voice-recording-chip
      onClick={onStop}
      type="button"
    >
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px] bg-current" />
      <span
        aria-hidden="true"
        className="shrink-0 text-[14px] leading-[22px] tracking-[-0.15px] tabular-nums"
      >
        {duration}
      </span>
      <VoiceWaveform stream={stream} />
    </button>
  );
}

function VoiceWaveform({ stream }: { stream: MediaStream | null }) {
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bars = Array.from(root.current?.children ?? []) as HTMLElement[];
    bars.forEach((bar) => {
      bar.style.height = "3px";
    });
    if (!stream || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let frame = 0;
    try {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      void context.resume().catch(() => undefined);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const start = Math.floor((280 * bins.length) / (context.sampleRate / 2));
      const end = Math.min(
        bins.length - 1,
        Math.ceil((6000 * bins.length) / (context.sampleRate / 2))
      );
      const count = end - start + 1;
      const levels: number[] = [];
      const draw = () => {
        analyser!.getByteFrequencyData(bins);
        bars.forEach((bar, index) => {
          const low = start + Math.floor((index * count) / bars.length);
          const high = Math.max(low, start + Math.floor(((index + 1) * count) / bars.length) - 1);
          let total = 0;
          for (let bin = low; bin <= high; bin++) total += (bins[bin] ?? 0) / 255;
          const target = Math.min(1, Math.max(0, total / (high - low + 1) - 0.2) * 2.2 * 0.8);
          const previous = levels[index];
          const weight = previous === undefined || target > previous ? 0.55 : 0.22;
          const level = previous === undefined ? target : previous * (1 - weight) + target * weight;
          levels[index] = level;
          bar.style.height = `${Math.max(3, level * 13)}px`;
        });
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    } catch {
      // A visualization failure must not interrupt the recording itself.
    }
    return () => {
      cancelAnimationFrame(frame);
      source?.disconnect();
      analyser?.disconnect();
      void context?.close().catch(() => undefined);
    };
  }, [stream]);
  return (
    <span
      aria-hidden="true"
      ref={root}
      data-voice-waveform
      className="flex h-[13px] w-[18px] shrink-0 items-center gap-0.5 text-[rgba(20,20,20,0.74)] dark:text-[rgba(240,240,240,0.74)]"
    >
      {[0, 1, 2, 3, 4].map((bar) => (
        <span key={bar} className="h-[3px] w-0.5 shrink-0 rounded-full bg-current" />
      ))}
    </span>
  );
}
