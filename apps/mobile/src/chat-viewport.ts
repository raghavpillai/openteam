export interface SequencedMessage {
  sequence: string;
}

export interface VisibleMessageToken<T extends SequencedMessage> {
  isViewable: boolean;
  item: T | null;
}

const numericSequence = (value: string): bigint | null =>
  /^\d+$/.test(value) ? BigInt(value) : null;

export const laterSequence = (left: string | null, right: string | null): string | null => {
  const leftNumber = left === null ? null : numericSequence(left);
  const rightNumber = right === null ? null : numericSequence(right);
  if (leftNumber === null) return rightNumber === null ? null : right;
  if (rightNumber === null) return left;
  return rightNumber > leftNumber ? right : left;
};

export const highestVisibleSequence = <T extends SequencedMessage>(
  tokens: readonly VisibleMessageToken<T>[]
): string | null => {
  let highest: string | null = null;
  for (const token of tokens) {
    if (!token.isViewable || !token.item) continue;
    highest = laterSequence(highest, token.item.sequence);
  }
  return highest;
};

export const isNearLiveEdge = (
  offsetY: number,
  viewportHeight: number,
  contentHeight: number,
  threshold = 72
): boolean => contentHeight - Math.max(0, offsetY) - viewportHeight <= threshold;

/** Layout and programmatic scroll events must never be mistaken for a reader's drag. */
export class ChatScrollState {
  following = true;
  contentHeight = 0;
  viewportHeight = 0;
  private userScrolling = false;
  private userMomentumPending = false;
  private latestFeedbackArmed = false;
  private latestFeedbackSent = false;

  get canCorrect(): boolean {
    return this.following && !this.userScrolling;
  }

  get bottomOffset(): number {
    // Includes content-container padding, unlike FlatList.scrollToEnd's row estimate.
    return Math.max(0, this.contentHeight - this.viewportHeight);
  }

  reset(following: boolean): void {
    this.setFollowing(following);
  }

  setFollowing(following: boolean): void {
    this.following = following;
    this.userScrolling = false;
    this.userMomentumPending = false;
    this.latestFeedbackArmed = false;
    this.latestFeedbackSent = false;
  }

  beginDrag(): void {
    this.userScrolling = true;
    this.userMomentumPending = true;
    this.following = false;
    this.latestFeedbackArmed = false;
    this.latestFeedbackSent = false;
  }

  endDrag(): void {
    this.userScrolling = false;
  }

  beginMomentum(): void {
    this.userScrolling = this.userMomentumPending;
  }

  endMomentum(): void {
    this.userScrolling = false;
    this.userMomentumPending = false;
  }

  /** Returns one feedback cue when an actual drag/momentum reaches the newest message. */
  observeScroll(offset: number, viewport: number, content: number, hasNewer: boolean): boolean {
    if (!this.userScrolling) return false;
    this.following = !hasNewer && isNearLiveEdge(offset, viewport, content);
    if (hasNewer || viewport <= 0 || content <= viewport) return false;
    const remaining = content - Math.max(0, offset) - viewport;
    // Require a deliberate trip away from the bottom; rubber-band jitter stays quiet.
    if (remaining >= 24) this.latestFeedbackArmed = true;
    if (!this.latestFeedbackArmed || this.latestFeedbackSent || remaining > 2) return false;
    this.latestFeedbackSent = true;
    return true;
  }
}

export const enteringAppendedMessageKeys = <T>(
  messages: readonly T[],
  knownKeys: ReadonlySet<string> | null,
  keyFor: (message: T) => string
): Set<string> => {
  if (!knownKeys || knownKeys.size === 0) return new Set();
  let lastKnownIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && knownKeys.has(keyFor(message))) {
      lastKnownIndex = index;
      break;
    }
  }
  if (lastKnownIndex < 0) return new Set();
  return new Set(
    messages
      .slice(lastKnownIndex + 1)
      .map(keyFor)
      .filter((key) => !knownKeys.has(key))
  );
};
