import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  computeVirtualLayout,
  computeVirtualRangeFromLayout,
  isVirtualScopeVisible,
} from "../lib/virtual-window";

export interface VirtualItem {
  index: number;
  key: string;
  size: number;
  start: number;
}

export function useVirtualWindow({
  count,
  estimateSize,
  getKey,
  scrollRef,
  overscan = 600,
  maxItems = 160,
  activeIndex,
  initialAlign = "start",
  initialViewportSize = 0,
  scopeRef,
  suspendOutsideViewport = false,
}: {
  count: number;
  estimateSize: (index: number) => number;
  getKey: (index: number) => string;
  scrollRef: RefObject<HTMLElement | null>;
  overscan?: number;
  maxItems?: number;
  activeIndex?: number;
  initialAlign?: "start" | "end";
  initialViewportSize?: number;
  /** Optional root whose local coordinates should be used inside a shared scrollport. */
  scopeRef?: RefObject<HTMLElement | null>;
  /** Mount no items while this scope is outside the scrollport plus overscan. */
  suspendOutsideViewport?: boolean;
}) {
  const measuredSizes = useRef(new Map<string, number>());
  const observedNodes = useRef(new Map<Element, { index: number; key: string }>());
  const observedNodeByKey = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const revisionFrame = useRef<number | null>(null);
  const [sizeRevision, setSizeRevision] = useState(0);
  const [viewport, setViewport] = useState(() => ({
    offset: initialAlign === "end" ? Number.POSITIVE_INFINITY : 0,
    size: Math.max(0, initialViewportSize),
    resolved: !scopeRef,
  }));

  const scopeOrigin = useCallback(() => {
    const scrollElement = scrollRef.current;
    const scopeElement = scopeRef?.current;
    if (!scrollElement || !scopeElement) return 0;
    const scrollBounds = scrollElement.getBoundingClientRect();
    const scopeBounds = scopeElement.getBoundingClientRect();
    return scopeBounds.top - scrollBounds.top + scrollElement.scrollTop;
  }, [scopeRef, scrollRef]);

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = {
      offset: element.scrollTop - scopeOrigin(),
      size: element.clientHeight,
      resolved: true,
    };
    setViewport((current) =>
      current.offset === next.offset &&
      current.size === next.size &&
      current.resolved === next.resolved
        ? current
        : next
    );
  }, [scopeOrigin, scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      updateViewport();
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    const resizeObserver = new ResizeObserver(schedule);
    element.addEventListener("scroll", schedule, { passive: true });
    resizeObserver.observe(element);
    if (scopeRef?.current) resizeObserver.observe(scopeRef.current);
    update();
    return () => {
      element.removeEventListener("scroll", schedule);
      resizeObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [scopeRef, scrollRef, updateViewport]);

  // A preceding group can expand, collapse, or be remeasured without changing
  // the scrollport's own box. Refresh nested coordinates after each commit;
  // the equality guard above prevents a render loop.
  useLayoutEffect(() => {
    if (scopeRef) updateViewport();
  });

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const metadata = observedNodes.current.get(entry.target);
        if (!metadata) continue;
        const next = Math.max(1, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
        if (Math.abs((measuredSizes.current.get(metadata.key) ?? 0) - next) < 0.5) continue;
        measuredSizes.current.set(metadata.key, next);
        changed = true;
      }
      if (!changed || revisionFrame.current !== null) return;
      revisionFrame.current = window.requestAnimationFrame(() => {
        revisionFrame.current = null;
        setSizeRevision((value) => value + 1);
      });
    });
    observerRef.current = observer;
    for (const node of observedNodes.current.keys()) observer.observe(node);
    return () => {
      observerRef.current = null;
      observer.disconnect();
      if (revisionFrame.current !== null) {
        window.cancelAnimationFrame(revisionFrame.current);
        revisionFrame.current = null;
      }
    };
  }, []);

  const layout = useMemo(() => {
    void sizeRevision;
    return computeVirtualLayout(
      count,
      (index) => measuredSizes.current.get(getKey(index)) ?? estimateSize(index)
    );
  }, [count, estimateSize, getKey, sizeRevision]);

  useEffect(() => {
    if (measuredSizes.current.size === 0) return;
    const currentKeys = new Set(Array.from({ length: count }, (_, index) => getKey(index)));
    for (const key of measuredSizes.current.keys()) {
      if (!currentKeys.has(key)) measuredSizes.current.delete(key);
    }
  }, [count, getKey]);
  const range = useMemo(
    () =>
      computeVirtualRangeFromLayout({
        ...layout,
        scrollOffset: viewport.offset,
        viewportSize: viewport.size,
        overscan,
        maxItems,
      }),
    [layout, maxItems, overscan, viewport]
  );
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const indexes = useMemo(() => {
    const scopeVisible =
      !suspendOutsideViewport ||
      (viewport.resolved &&
        isVirtualScopeVisible({
          scrollOffset: viewport.offset,
          viewportSize: viewport.size,
          totalSize: range.totalSize,
          overscan,
        }));
    if (!scopeVisible) {
      return activeIndex !== undefined && activeIndex >= 0 && activeIndex < count
        ? [activeIndex]
        : [];
    }
    const values = Array.from(
      { length: range.endIndex - range.startIndex },
      (_, offset) => range.startIndex + offset
    );
    if (
      activeIndex !== undefined &&
      activeIndex >= 0 &&
      activeIndex < count &&
      !values.includes(activeIndex)
    ) {
      values.push(activeIndex);
      values.sort((left, right) => left - right);
    }
    return values;
  }, [
    activeIndex,
    count,
    overscan,
    range.endIndex,
    range.startIndex,
    range.totalSize,
    suspendOutsideViewport,
    viewport.offset,
    viewport.resolved,
    viewport.size,
  ]);

  const virtualItems = useMemo<VirtualItem[]>(() => {
    void sizeRevision;
    return indexes.map((index) => {
      const key = getKey(index);
      return {
        index,
        key,
        start: range.offsets[index] ?? 0,
        size: measuredSizes.current.get(key) ?? estimateSize(index),
      };
    });
  }, [estimateSize, getKey, indexes, range.offsets, sizeRevision]);

  const measureElement = useCallback((index: number, key: string, node: HTMLElement | null) => {
    const previousForKey = observedNodeByKey.current.get(key);
    if (previousForKey && previousForKey !== node) {
      observerRef.current?.unobserve(previousForKey);
      observedNodes.current.delete(previousForKey);
      observedNodeByKey.current.delete(key);
    }
    if (!node) return;
    const previousForNode = observedNodes.current.get(node);
    if (previousForNode && previousForNode.key !== key) {
      observedNodeByKey.current.delete(previousForNode.key);
    }
    observedNodes.current.set(node, { index, key });
    observedNodeByKey.current.set(key, node);
    observerRef.current?.observe(node);
  }, []);

  const scrollToIndex = useCallback(
    (
      index: number,
      options: {
        align?: "start" | "center" | "end";
        behavior?: ScrollBehavior;
      } = {}
    ) => {
      const element = scrollRef.current;
      const currentRange = rangeRef.current;
      if (!element || index < 0 || index >= count) return;
      const start = currentRange.offsets[index] ?? 0;
      const size = measuredSizes.current.get(getKey(index)) ?? estimateSize(index);
      const align = options.align ?? "center";
      const top =
        align === "start"
          ? start
          : align === "end"
            ? start + size - element.clientHeight
            : start + size / 2 - element.clientHeight / 2;
      element.scrollTo({
        top: Math.max(0, scopeOrigin() + top),
        behavior: options.behavior ?? "auto",
      });
    },
    [count, estimateSize, getKey, scopeOrigin, scrollRef]
  );

  const followedActiveItem = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (activeIndex === undefined || activeIndex < 0 || activeIndex >= count) {
      followedActiveItem.current = null;
      return;
    }
    const activeKey = `${activeIndex}:${getKey(activeIndex)}`;
    if (followedActiveItem.current === activeKey) return;
    const element = scrollRef.current;
    if (!element) return;
    followedActiveItem.current = activeKey;
    const start = scopeOrigin() + (range.offsets[activeIndex] ?? 0);
    const size = measuredSizes.current.get(getKey(activeIndex)) ?? estimateSize(activeIndex);
    const end = start + size;
    if (start < element.scrollTop) element.scrollTop = start;
    else if (end > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, end - element.clientHeight);
    }
  }, [activeIndex, count, estimateSize, getKey, range.offsets, scopeOrigin, scrollRef]);

  return {
    measureElement,
    scrollToIndex,
    totalSize: range.totalSize,
    virtualItems,
  };
}
