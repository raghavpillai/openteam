export const REPLY_SWIPE_THRESHOLD = 52;
export const REPLY_SWIPE_RESET = 40;

/** One tactile cue per gesture; hysteresis keeps the armed state stable near the threshold. */
export class ReplySwipe {
  private armed = false;
  private didSignal = false;

  reset() {
    this.armed = false;
    this.didSignal = false;
  }

  move(distance: number): boolean {
    this.update(distance);
    if (!this.armed || this.didSignal) return false;
    this.didSignal = true;
    return true;
  }

  release(distance: number, velocity: number): { open: boolean; signal: boolean } {
    this.update(distance);
    const open = this.armed || (distance >= 24 && velocity >= 0.65);
    const signal = open && !this.didSignal;
    this.reset();
    return { open, signal };
  }

  private update(distance: number) {
    if (distance >= REPLY_SWIPE_THRESHOLD) this.armed = true;
    else if (distance < REPLY_SWIPE_RESET) this.armed = false;
  }
}
