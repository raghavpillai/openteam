export interface VoiceVadOptions { threshold: number; startMs: number; endSilenceMs: number; maxTurnMs: number }
export type VoiceVadEvent = { type: "started" } | { type: "ended" } | { type: "barge_in" };

const defaults: VoiceVadOptions = { threshold: 900, startMs: 120, endSilenceMs: 650, maxTurnMs: 60_000 };

export class VoiceVad {
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private turnMs = 0;
  constructor(private readonly options: VoiceVadOptions = defaults) {}

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.turnMs = 0;
  }

  observe(pcm: Int16Array, playbackActive: boolean, echoCancellation: boolean): VoiceVadEvent[] {
    const rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / Math.max(1, pcm.length));
    const frameMs = Math.max(1, Math.round(pcm.length / 16));
    const voice = rms >= this.options.threshold;
    const events: VoiceVadEvent[] = [];
    if (voice) {
      this.speechMs += frameMs; this.silenceMs = 0;
      if (!this.speaking && this.speechMs >= this.options.startMs) { this.speaking = true; this.turnMs = 0; events.push({ type: "started" }); }
      if (playbackActive && echoCancellation && this.speaking) events.push({ type: "barge_in" });
    } else {
      this.speechMs = 0;
      if (this.speaking) { this.silenceMs += frameMs; if (this.silenceMs >= this.options.endSilenceMs) { this.speaking = false; events.push({ type: "ended" }); } }
    }
    if (this.speaking) { this.turnMs += frameMs; if (this.turnMs >= this.options.maxTurnMs) { this.speaking = false; events.push({ type: "ended" }); } }
    return events;
  }
}
