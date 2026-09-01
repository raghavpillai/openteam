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
