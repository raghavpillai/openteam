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
  scrollTopForAnchoredItem,
  type VirtualLayout,
} from "../lib/virtual-window";
import {
  createVirtualMeasurements,
  setVirtualMeasurement,
  setVirtualMeasurementWidth,
  type VirtualMeasurements,
} from "../lib/virtual-measurements";

export type InitialVirtualScroll =
  | "end"
  | { index: number; viewportOffset: number }
  | { index: number; align: "center" };

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
  initialScroll,
  followEnd,
  measurementCache,
  getMeasurementVersion = getKey,
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
  /** Position after measuring the initial window, before publishing its viewport. */
  initialScroll?: InitialVirtualScroll;
  /** Keep logical end alignment through measurements while the reader follows latest. */
  followEnd?: () => boolean;
  measurementCache?: VirtualMeasurements;
  getMeasurementVersion?: (index: number) => string | number;
}) {
  const [measurements] = useState(() => measurementCache ?? createVirtualMeasurements());
  const measurementVersionRef = useRef(getMeasurementVersion);
  measurementVersionRef.current = getMeasurementVersion;
  const initialTarget = useRef(initialScroll);
  const initializing = useRef(initialScroll !== undefined);
  const [scrollInitialized, setScrollInitialized] = useState(initialScroll === undefined);
  const checkedNodes = useRef(new WeakSet<Element>());
  const latestLayout = useRef<VirtualLayout | null>(null);
  const readingAnchor = useRef<{ index: number; key: string; viewportOffset: number } | null>(null);
  const resizeAnchor = useRef<typeof readingAnchor.current>(null);
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
    if (initializing.current || resizeAnchor.current) return;
    const element = scrollRef.current;
    if (!element) return;
    const next = {
      offset: element.scrollTop - scopeOrigin(),
      size: element.clientHeight,
      resolved: true,
    };
    // Remember the logical row before a width change invalidates its geometry.
    // These are layout-array reads; scrolling does not measure every DOM row.
    const currentLayout = latestLayout.current;
    if (
      initialTarget.current !== undefined &&
      currentLayout &&
      measurements.width === (scopeRef?.current?.clientWidth ?? element.clientWidth)
    ) {
      let first: { index: number; key: string; viewportOffset: number } | null = null;
      for (const { index, key } of observedNodes.current.values()) {
        const start = currentLayout.offsets[index] ?? 0;
        const end = start + (currentLayout.sizes[index] ?? 0);
        if (
          end > next.offset &&
          start < next.offset + next.size &&
          (!first || index < first.index)
        ) {
          first = { index, key, viewportOffset: start - next.offset };
        }
      }
      if (first) readingAnchor.current = first;
    }
    setViewport((current) =>
      current.offset === next.offset &&
      current.size === next.size &&
      current.resolved === next.resolved
        ? current
        : next
    );
  }, [measurements, scopeOrigin, scopeRef, scrollRef]);

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

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const metadata = observedNodes.current.get(entry.target);
        if (!metadata) continue;
        const next = Math.max(1, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
        changed =
          setVirtualMeasurement(
            measurements,
            metadata.key,
            measurementVersionRef.current(metadata.index),
            next
          ) || changed;
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

  const measuredSizeAt = useCallback(
    (index: number) => {
      const cached = measurements.rows.get(getKey(index));
      return cached?.version === getMeasurementVersion(index) ? cached.size : estimateSize(index);
    },
    [estimateSize, getKey, getMeasurementVersion, measurements]
  );

  const layout = useMemo(() => {
    void sizeRevision;
    return computeVirtualLayout(count, measuredSizeAt);
  }, [count, measuredSizeAt, sizeRevision]);
  latestLayout.current = layout;

  useEffect(() => {
    if (measurements.rows.size === 0) return;
    const currentKeys = new Set(Array.from({ length: count }, (_, index) => getKey(index)));
    for (const key of measurements.rows.keys()) {
      if (!currentKeys.has(key)) measurements.rows.delete(key);
    }
  }, [count, getKey, measurements]);
  const retainedResizeAnchor = resizeAnchor.current;
  const resizeIndex = retainedResizeAnchor
    ? getKey(retainedResizeAnchor.index) === retainedResizeAnchor.key
      ? retainedResizeAnchor.index
      : Array.from({ length: count }, (_, index) => getKey(index)).indexOf(retainedResizeAnchor.key)
    : -1;
  const resizeTarget =
    resizeIndex >= 0 && retainedResizeAnchor
      ? { index: resizeIndex, viewportOffset: retainedResizeAnchor.viewportOffset }
      : undefined;
  const target = initializing.current ? initialTarget.current : resizeTarget;
  const rangeOffset =
    target === "end" || (!target && !initializing.current && followEnd?.())
      ? Number.POSITIVE_INFINITY
      : target
        ? (layout.offsets[target.index] ?? 0) -
          ("viewportOffset" in target
            ? target.viewportOffset
            : (viewport.size - measuredSizeAt(target.index)) / 2)
        : viewport.offset;
  const range = useMemo(
    () =>
      computeVirtualRangeFromLayout({
        ...layout,
        scrollOffset: rangeOffset,
        viewportSize: viewport.size,
        overscan,
        maxItems,
      }),
    [layout, maxItems, overscan, rangeOffset, viewport.size]
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
        size: measuredSizeAt(index),
      };
    });
  }, [measuredSizeAt, getKey, indexes, range.offsets, sizeRevision]);

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
      const size = measuredSizeAt(index);
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
    [count, measuredSizeAt, scopeOrigin, scrollRef]
  );

  // Initial geometry is synchronous and bounded by the mounted virtual window.
  // Do not let a default scrollTop=0 replace the intended end/message range
  // while those rows are being measured. Later new rows and width changes use
  // the same path; ResizeObserver handles changes inside already-mounted rows.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (initialTarget.current !== undefined && count > 0 && element.clientHeight > 0) {
      const initialViewportChanged = initializing.current && viewport.size !== element.clientHeight;
      if (initialViewportChanged) {
        setViewport((current) => ({ ...current, size: element.clientHeight }));
      }
      const width = scopeRef?.current?.clientWidth ?? element.clientWidth;
      if (measurements.width !== width && !initializing.current && !followEnd?.()) {
        resizeAnchor.current ??= readingAnchor.current;
      }
      let changed = setVirtualMeasurementWidth(measurements, width);
      if (changed) checkedNodes.current = new WeakSet();
      for (const [node, metadata] of observedNodes.current) {
        const version = getMeasurementVersion(metadata.index);
        if (
          !initializing.current &&
          checkedNodes.current.has(node) &&
          measurements.rows.get(metadata.key)?.version === version
        )
          continue;
        checkedNodes.current.add(node);
        changed =
          setVirtualMeasurement(
            measurements,
            metadata.key,
            version,
            Math.max(1, node.getBoundingClientRect().height)
          ) || changed;
      }
      if (changed) {
        setSizeRevision((value) => value + 1);
        return;
      }
      if (initialViewportChanged) return;
      const initial = initialTarget.current;
      if (resizeTarget) {
        scrollIndexToViewportOffset(resizeTarget.index, resizeTarget.viewportOffset);
      } else if (initializing.current && initial !== "end") {
        if ("viewportOffset" in initial) {
          scrollIndexToViewportOffset(initial.index, initial.viewportOffset);
        } else {
          scrollToIndex(initial.index, { align: "center" });
        }
      } else if ((initializing.current && initial === "end") || followEnd?.()) {
        // Layout corrections never animate or traverse intermediate windows.
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
        if (Math.abs(element.scrollTop - bottom) > 1) element.scrollTop = bottom;
      }
      if (initializing.current) {
        initializing.current = false;
        setScrollInitialized(true);
      }
      resizeAnchor.current = null;
    }
    // Preceding groups can move a nested scope without resizing the scrollport.
    if (scopeRef || initialTarget.current !== undefined) updateViewport();
  });

  const scrollIndexToViewportOffset = useCallback(
    (index: number, viewportOffset: number) => {
      const element = scrollRef.current;
      if (!element || index < 0 || index >= count) return false;
      element.scrollTop = scrollTopForAnchoredItem({
        itemStart: range.offsets[index] ?? 0,
        scopeOrigin: scopeOrigin(),
        viewportOffset,
        maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
      });
      return true;
    },
    [count, range.offsets, scopeOrigin, scrollRef]
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
    const size = measuredSizeAt(activeIndex);
    const end = start + size;
    if (start < element.scrollTop) element.scrollTop = start;
    else if (end > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, end - element.clientHeight);
    }
  }, [activeIndex, count, measuredSizeAt, getKey, range.offsets, scopeOrigin, scrollRef]);

  return {
    measureElement,
    scrollInitialized,
    scrollIndexToViewportOffset,
    scrollToIndex,
    totalSize: range.totalSize,
    virtualItems,
  };
}
