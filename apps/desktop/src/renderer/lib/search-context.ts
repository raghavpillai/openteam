export interface ContextGapEntry {
  type: "context_gap";
  id: string;
  createdAt: string;
}

export const addContextGaps = <T extends { id: string; createdAt: string }>(
  entries: readonly T[],
  isContext: (entry: T) => boolean
): Array<T | ContextGapEntry> => {
  const result: Array<T | ContextGapEntry> = [];
  let previousWasContext: boolean | null = null;
  for (const entry of entries) {
    const entryIsContext = isContext(entry);
    if (previousWasContext !== null && previousWasContext !== entryIsContext) {
      result.push({
        type: "context_gap",
        id: `context-gap:${entry.id}`,
        createdAt: new Date(new Date(entry.createdAt).getTime() - 1).toISOString(),
      });
    }
    result.push(entry);
    previousWasContext = entryIsContext;
  }
  return result;
};
