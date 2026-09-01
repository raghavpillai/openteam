export interface VirtualRangeInput {
  count: number;
  scrollOffset: number;
  viewportSize: number;
  overscan: number;
  maxItems: number;
  sizeAt: (index: number) => number;
}

export interface VirtualRange {
  offsets: number[];
  startIndex: number;
  endIndex: number;
  totalSize: number;
}

export interface VirtualLayout {
  offsets: number[];
  sizes: number[];
  totalSize: number;
}

export interface VirtualScopeVisibilityInput {
  /** Scroll position expressed in coordinates local to the virtual scope. */
  scrollOffset: number;
  viewportSize: number;
  totalSize: number;
  overscan: number;
}

/**
 * Returns whether a nested virtual scope intersects the scrollport (including
 * overscan). This keeps a sidebar with many groups from mounting a window for
 * every off-screen group.
 */
export function isVirtualScopeVisible({
  scrollOffset,
  viewportSize,
  totalSize,
  overscan,
}: VirtualScopeVisibilityInput) {
  if (![scrollOffset, viewportSize, totalSize, overscan].every(Number.isFinite)) return false;
  const boundedViewport = Math.max(0, viewportSize);
  const boundedTotal = Math.max(0, totalSize);
  const boundedOverscan = Math.max(0, overscan);
  return (
    scrollOffset + boundedViewport + boundedOverscan >= 0 &&
    scrollOffset - boundedOverscan <= boundedTotal
  );
}

export const preservePrependScrollOffset = (
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number
) => Math.max(0, previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight));

export const computeVirtualLayout = (
  count: number,
  sizeAt: (index: number) => number
): VirtualLayout => {
  const safeCount = Math.max(0, Math.floor(count));
  const offsets = new Array<number>(safeCount);
  const sizes = new Array<number>(safeCount);
  let totalSize = 0;
  for (let index = 0; index < safeCount; index += 1) {
    offsets[index] = totalSize;
    const measured = sizeAt(index);
    const size = Number.isFinite(measured) ? Math.max(1, measured) : 1;
    sizes[index] = size;
    totalSize += size;
  }
  return { offsets, sizes, totalSize };
};

const firstItemEndingAfter = (offsets: number[], sizes: number[], target: number) => {
  let low = 0;
  let high = sizes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] ?? 0) + (sizes[middle] ?? 0) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Computes a bounded virtual range. This is deliberately DOM-independent so
 * scale limits and scroll coverage can be tested without a browser runtime.
 */
export function computeVirtualRange({
  count,
  scrollOffset,
  viewportSize,
  overscan,
  maxItems,
  sizeAt,
}: VirtualRangeInput): VirtualRange {
  const safeCount = Math.max(0, Math.floor(count));
  const { offsets, sizes, totalSize } = computeVirtualLayout(safeCount, sizeAt);

  return computeVirtualRangeFromLayout({
    offsets,
    sizes,
    totalSize,
    scrollOffset,
    viewportSize,
    overscan,
    maxItems,
  });
}

export function computeVirtualRangeFromLayout({
  offsets,
  sizes,
  totalSize,
  scrollOffset,
  viewportSize,
  overscan,
  maxItems,
}: VirtualLayout & Omit<VirtualRangeInput, "count" | "sizeAt">): VirtualRange {
  const safeCount = sizes.length;

  if (safeCount === 0) {
    return { offsets, startIndex: 0, endIndex: 0, totalSize: 0 };
  }

  const boundedViewport = Math.max(0, viewportSize);
  const boundedOverscan = Math.max(0, overscan);
  const maximum = Math.max(1, Math.floor(maxItems));
  const effectiveOffset = Number.isFinite(scrollOffset)
    ? Math.max(0, Math.min(scrollOffset, Math.max(0, totalSize - boundedViewport)))
    : Math.max(0, totalSize - boundedViewport);
  const rangeStart = Math.max(0, effectiveOffset - boundedOverscan);
  const rangeEnd = Math.min(totalSize, effectiveOffset + boundedViewport + boundedOverscan);
  const startIndex = Math.min(safeCount - 1, firstItemEndingAfter(offsets, sizes, rangeStart));
  let endIndex = startIndex;
  while (
    endIndex < safeCount &&
    endIndex - startIndex < maximum &&
    (offsets[endIndex] ?? totalSize) < rangeEnd
  ) {
    endIndex += 1;
  }
  if (endIndex === startIndex) endIndex = Math.min(safeCount, startIndex + 1);

  return { offsets, startIndex, endIndex, totalSize };
}
