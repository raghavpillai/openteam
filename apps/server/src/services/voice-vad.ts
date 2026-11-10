export interface VoiceVadOptions {
  threshold: number;
  startMs: number;
  endSilenceMs: number;
  maxTurnMs: number;
  /** Quiet gap, in ms, that may sit inside the start window without restarting it (speech dips between syllables). */
  startGapMs?: number;
}
export type VoiceVadEvent = { type: "started" } | { type: "ended" } | { type: "barge_in" };

// A turn starts only after 300 ms of speech-level sound. Anything quieter than an RMS of 1400
// (distant voices, TV, room noise) or shorter than that (clicks, coughs) never opens a turn.
const defaults: VoiceVadOptions = {
  threshold: 1400,
  startMs: 300,
  endSilenceMs: 650,
  maxTurnMs: 60_000,
  startGapMs: 100,
};

/**
 * Keeps the most recent audio from before a turn opens. The start window means the first
 * few hundred milliseconds of a sentence arrive before the turn exists, and they belong to it.
 */
export class PcmPreroll {
  private frames: Int16Array[] = [];
  private ms = 0;
  constructor(private readonly maxMs = 600) {}
  push(pcm: Int16Array): void {
    this.frames.push(pcm);
    this.ms += pcm.length / 16;
    while (this.ms > this.maxMs && this.frames.length > 0)
      this.ms -= this.frames.shift()!.length / 16;
  }
  drain(): Int16Array[] {
    const frames = this.frames;
    this.frames = [];
    this.ms = 0;
    return frames;
  }
}

export class VoiceVad {
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private gapMs = 0;
  private turnMs = 0;
  constructor(private readonly options: VoiceVadOptions = defaults) {}

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.gapMs = 0;
    this.turnMs = 0;
  }

  observe(pcm: Int16Array, playbackActive: boolean, echoCancellation: boolean): VoiceVadEvent[] {
    const rms = Math.sqrt(
      pcm.reduce((sum, value) => sum + value * value, 0) / Math.max(1, pcm.length)
    );
    const frameMs = Math.max(1, Math.round(pcm.length / 16));
    const voice = rms >= this.options.threshold;
    const events: VoiceVadEvent[] = [];
    if (voice) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
      this.gapMs = 0;
      if (!this.speaking && this.speechMs >= this.options.startMs) {
        this.speaking = true;
        this.turnMs = 0;
        events.push({ type: "started" });
      }
      if (playbackActive && echoCancellation && this.speaking) events.push({ type: "barge_in" });
    } else {
      if (this.speaking) this.speechMs = 0;
      else {
        this.gapMs += frameMs;
        if (this.gapMs > (this.options.startGapMs ?? 0)) {
          this.speechMs = 0;
          this.gapMs = 0;
        }
      }
      if (this.speaking) {
        this.silenceMs += frameMs;
        if (this.silenceMs >= this.options.endSilenceMs) {
          this.speaking = false;
          events.push({ type: "ended" });
        }
      }
    }
    if (this.speaking) {
      this.turnMs += frameMs;
      if (this.turnMs >= this.options.maxTurnMs) {
        this.speaking = false;
        events.push({ type: "ended" });
      }
    }
    return events;
  }
}
