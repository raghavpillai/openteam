import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { type InitialVirtualScroll, useVirtualWindow } from "../../hooks/use-virtual-window";
import {
  type ConversationScrollState,
  resolveConversationScrollRestore,
} from "../../lib/conversation-scroll-state";
import { nextHistoryPageLoadStartedAt } from "../../lib/history-pagination";
import { recordPerformance } from "../../lib/performance";
import {
  createVirtualMeasurements,
  type VirtualMeasurements,
} from "../../lib/virtual-measurements";

const conversationScrollPositions = new Map<string, ConversationScrollState>();
const conversationMeasurements = new Map<
  string,
  { generation: number; cache: VirtualMeasurements }
>();
const entryVersions = new WeakMap<object, number>();
let nextEntryVersion = 0;

const measurementsForConversation = (id: string, generation: number) => {
  const previous = conversationMeasurements.get(id);
  const value =
    previous?.generation === generation
      ? previous
      : { generation, cache: createVirtualMeasurements() };
  conversationMeasurements.delete(id);
  conversationMeasurements.set(id, value);
  if (conversationMeasurements.size > 20) {
    const oldest = conversationMeasurements.keys().next().value;
    if (oldest !== undefined) conversationMeasurements.delete(oldest);
  }
  return value.cache;
};

interface PendingScrollAnchor {
  automatic: boolean;
  direction: "older" | "newer";
  key: string;
  maxErrorPx: number;
  reported: boolean;
  startedAt: number;
  survived: boolean;
  viewportOffset: number;
}

export function VirtualizedTimeline<T extends { id: string; type: string }>({
  conversationId,
  entries,
  focus,
  hasOlder = false,
  hasNewer = false,
  loadingOlder = false,
  loadingNewer = false,
  historyGeneration = 0,
  onLoadOlder,
  onLoadNewer,
  onViewportMessagesChange,
  messageIdsForEntry,
  renderEntry,
}: {
  conversationId: string;
  entries: T[];
  focus: { index: number; messageId: string; nonce: number } | null;
  hasOlder?: boolean;
  hasNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  historyGeneration?: number;
  onLoadOlder?: (viewportMessageIds?: readonly string[]) => unknown;
  onLoadNewer?: (viewportMessageIds?: readonly string[]) => unknown;
  onViewportMessagesChange?: (
    messageIds: readonly string[],
    fill: "older-first" | "newer-first"
  ) => void;
  messageIdsForEntry: (entry: T) => readonly string[];
  renderEntry: (entry: T, index: number) => ReactNode;
}) {
  const { scrollRef, stopScroll, state } = useStickToBottomContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const focusWindowRef = useRef<{ key: string; expiresAt: number } | null>(null);
  const loadingRequest = useRef(false);
  const lastOlderLoadStartedAt = useRef(0);
  const lastNewerLoadStartedAt = useRef(0);
  const anchorCleanupTimer = useRef<number | null>(null);
  const viewportReportFrame = useRef<number | null>(null);
  const viewportFill = useRef<"older-first" | "newer-first">("newer-first");
  const lastReportedViewport = useRef("");
  const saveConversationScrollStateRef = useRef<() => void>(() => undefined);
  const pendingScrollAnchor = useRef<PendingScrollAnchor | null>(null);
  const [measurementCache] = useState(() =>
    measurementsForConversation(conversationId, historyGeneration)
  );
  const [initialScroll] = useState<InitialVirtualScroll>(() => {
    if (focus) return { index: focus.index, align: "center" };
    const restore = resolveConversationScrollRestore({
      currentGeneration: historyGeneration,
      messageIds: entries.map((entry) => messageIdsForEntry(entry)[0] ?? null),
      stored: conversationScrollPositions.get(conversationId),
    });
    return restore.kind === "message"
      ? { index: restore.index, viewportOffset: restore.viewportOffset }
      : "end";
  });
  useLayoutEffect(() => {
    // Restored reading positions and search targets must release the library's
    // default bottom lock before any measurement can trigger its observer.
    if (initialScroll !== "end") stopScroll();
  }, [initialScroll, stopScroll]);
  const followEnd = useCallback(() => state.isAtBottom && !pendingScrollAnchor.current, [state]);
  const getMeasurementVersion = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return 0;
      let version = entryVersions.get(entry);
      if (version === undefined) {
        version = ++nextEntryVersion;
        entryVersions.set(entry, version);
      }
      return version;
    },
    [entries]
  );
  const estimateSize = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return 72;
      if (entry.type === "approval") return 180;
      if (entry.type === "a2a") return 40;
      if (entry.type === "thinking") return 36;
      if (entry.type === "context_gap") return 52;
      return 72;
    },
    [entries]
  );
  const getKey = useCallback(
    (index: number) => {
      const entry = entries[index];
      return entry ? `${entry.type}:${entry.id}` : `missing:${index}`;
    },
    [entries]
  );
  const {
    measureElement,
    scrollInitialized,
    scrollIndexToViewportOffset,
    scrollToIndex,
    totalSize,
    virtualItems,
  } = useVirtualWindow({
    count: entries.length,
    activeIndex: focus?.index,
    estimateSize,
    getKey,
    scrollRef,
    initialAlign: "end",
    initialViewportSize: scrollRef.current?.clientHeight ?? 900,
    maxItems: 80,
    overscan: 900,
    scopeRef: contentRef,
    initialScroll,
    followEnd,
    measurementCache,
    getMeasurementVersion,
  });

  const visibleMessageIds = useCallback((): string[] => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!scrollInitialized || !viewport || !content) return [];
    const viewportBounds = viewport.getBoundingClientRect();
    const ids = new Set<string>();
    for (const row of content.querySelectorAll<HTMLElement>("[data-virtual-timeline-index]")) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom <= viewportBounds.top || bounds.top >= viewportBounds.bottom) continue;
      const index = Number(row.dataset.virtualTimelineIndex);
      const entry = Number.isSafeInteger(index) ? entries[index] : undefined;
      if (!entry) continue;
      for (const id of messageIdsForEntry(entry)) ids.add(id);
    }
    return [...ids];
  }, [entries, messageIdsForEntry, scrollInitialized, scrollRef]);

  const reportVisibleMessages = useCallback(
    (fill = viewportFill.current): string[] => {
      if (!scrollInitialized) return [];
      const messageIds = visibleMessageIds();
      const signature = `${fill}:${messageIds.join("\u0000")}`;
      if (signature === lastReportedViewport.current) return messageIds;
      lastReportedViewport.current = signature;
      onViewportMessagesChange?.(messageIds, fill);
      return messageIds;
    },
    [onViewportMessagesChange, scrollInitialized, visibleMessageIds]
  );
  const reportVisibleMessagesRef = useRef(reportVisibleMessages);
  reportVisibleMessagesRef.current = reportVisibleMessages;

  const scheduleViewportReport = useCallback(() => {
    if (viewportReportFrame.current !== null) return;
    viewportReportFrame.current = window.requestAnimationFrame(() => {
      viewportReportFrame.current = null;
      reportVisibleMessagesRef.current();
    });
  }, []);

  const saveConversationScrollState = useCallback(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!scrollInitialized || !viewport || !content || viewport.clientHeight <= 0) return;
    const viewportBounds = viewport.getBoundingClientRect();
    const visibleRow = Array.from(
      content.querySelectorAll<HTMLElement>("[data-virtual-timeline-index]")
    ).find((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > viewportBounds.top && bounds.top < viewportBounds.bottom;
    });
    const visibleIndex = Number(visibleRow?.dataset.virtualTimelineIndex);
    const visibleEntry = Number.isSafeInteger(visibleIndex) ? entries[visibleIndex] : undefined;
    conversationScrollPositions.set(conversationId, {
      bottomDistance: Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      ),
      historyGeneration,
      messageId: visibleEntry ? (messageIdsForEntry(visibleEntry)[0] ?? null) : null,
      viewportOffset: visibleRow ? visibleRow.getBoundingClientRect().top - viewportBounds.top : 0,
    });
    if (conversationScrollPositions.size > 20) {
      const oldestConversationId = conversationScrollPositions.keys().next().value;
      if (oldestConversationId) conversationScrollPositions.delete(oldestConversationId);
    }
  }, [
    conversationId,
    entries,
    historyGeneration,
    messageIdsForEntry,
    scrollInitialized,
    scrollRef,
  ]);
  saveConversationScrollStateRef.current = saveConversationScrollState;

  useLayoutEffect(() => {
    if (scrollInitialized) saveConversationScrollStateRef.current();
    return () => saveConversationScrollStateRef.current();
  }, [scrollInitialized]);

  useEffect(
    () => () => {
      if (anchorCleanupTimer.current !== null) {
        window.clearTimeout(anchorCleanupTimer.current);
        anchorCleanupTimer.current = null;
      }
      if (viewportReportFrame.current !== null) {
        window.cancelAnimationFrame(viewportReportFrame.current);
        viewportReportFrame.current = null;
      }
    },
    []
  );

  const captureVisibleAnchor = useCallback(
    (direction: "older" | "newer", automatic: boolean) => {
      const viewport = scrollRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return null;
      const viewportBounds = viewport.getBoundingClientRect();
      const rows = content.querySelectorAll<HTMLElement>("[data-virtual-timeline-key]");
      let visibleRow: HTMLElement | null = null;
      for (const row of rows) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom > viewportBounds.top && bounds.top < viewportBounds.bottom) {
          visibleRow = row;
          break;
        }
      }
      const key = visibleRow?.dataset.virtualTimelineKey;
      if (!visibleRow || !key) return null;
      const anchor = {
        automatic,
        direction,
        key,
        maxErrorPx: 0,
        reported: false,
        startedAt: performance.now(),
        survived: true,
        viewportOffset: visibleRow.getBoundingClientRect().top - viewportBounds.top,
      };
      pendingScrollAnchor.current = anchor;
      stopScroll();
      return anchor;
    },
    [scrollRef, stopScroll]
  );

  const sampleScrollAnchor = useCallback(
    (anchor: PendingScrollAnchor): number | null => {
      if (pendingScrollAnchor.current !== anchor) return null;
      const viewport = scrollRef.current;
      const row = Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>("[data-virtual-timeline-key]") ?? []
      ).find((candidate) => candidate.dataset.virtualTimelineKey === anchor.key);
      if (!viewport || !row) {
        anchor.survived = false;
        return null;
      }
      const error = Math.abs(
        row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          anchor.viewportOffset
      );
      anchor.maxErrorPx = Math.max(anchor.maxErrorPx, error);
      return error;
    },
    [scrollRef]
  );

  const finishScrollAnchor = useCallback(
    (anchor: PendingScrollAnchor) => {
      if (pendingScrollAnchor.current !== anchor) return;
      sampleScrollAnchor(anchor);
      recordPerformance("history.anchor.max-error-px", anchor.maxErrorPx, {
        automatic: anchor.automatic,
        direction: anchor.direction,
        settleMs: Math.round(performance.now() - anchor.startedAt),
      });
      recordPerformance("history.anchor.row-survived", anchor.survived ? 1 : 0, {
        automatic: anchor.automatic,
        direction: anchor.direction,
      });
      pendingScrollAnchor.current = null;
    },
    [sampleScrollAnchor]
  );

  const loadOlder = useCallback(
    (automatic = false) => {
      const viewport = scrollRef.current;
      if (!viewport || !hasOlder || loadingOlder || loadingRequest.current || !onLoadOlder) return;
      const now = performance.now();
      const startedAt = automatic
        ? nextHistoryPageLoadStartedAt({
            now,
            lastStartedAt: lastOlderLoadStartedAt.current || null,
          })
        : now;
      if (startedAt === null) return;
      lastOlderLoadStartedAt.current = startedAt;
      loadingRequest.current = true;
      if (anchorCleanupTimer.current !== null) {
        window.clearTimeout(anchorCleanupTimer.current);
        anchorCleanupTimer.current = null;
      }
      const anchor = captureVisibleAnchor("older", automatic);
      viewportFill.current = "older-first";
      const viewportMessageIds = reportVisibleMessages("older-first");
      void Promise.resolve(onLoadOlder(viewportMessageIds))
        .catch(() => {
          if (anchor && pendingScrollAnchor.current === anchor) pendingScrollAnchor.current = null;
        })
        .finally(() => {
          loadingRequest.current = false;
          anchorCleanupTimer.current = window.setTimeout(() => {
            if (anchor) finishScrollAnchor(anchor);
            anchorCleanupTimer.current = null;
          }, 1_000);
        });
    },
    [
      captureVisibleAnchor,
      finishScrollAnchor,
      hasOlder,
      loadingOlder,
      onLoadOlder,
      reportVisibleMessages,
      scrollRef,
    ]
  );

  const loadNewer = useCallback(
    (automatic = false) => {
      const viewport = scrollRef.current;
      if (!viewport || !hasNewer || loadingNewer || loadingRequest.current || !onLoadNewer) return;
      const now = performance.now();
      const startedAt = automatic
        ? nextHistoryPageLoadStartedAt({
            now,
            lastStartedAt: lastNewerLoadStartedAt.current || null,
          })
        : now;
      if (startedAt === null) return;
      lastNewerLoadStartedAt.current = startedAt;
      loadingRequest.current = true;
      if (anchorCleanupTimer.current !== null) {
        window.clearTimeout(anchorCleanupTimer.current);
        anchorCleanupTimer.current = null;
      }
      const anchor = captureVisibleAnchor("newer", automatic);
      viewportFill.current = "newer-first";
      const viewportMessageIds = reportVisibleMessages("newer-first");
      void Promise.resolve(onLoadNewer(viewportMessageIds))
        .catch(() => {
          if (anchor && pendingScrollAnchor.current === anchor) pendingScrollAnchor.current = null;
        })
        .finally(() => {
          loadingRequest.current = false;
          anchorCleanupTimer.current = window.setTimeout(() => {
            if (anchor) finishScrollAnchor(anchor);
            anchorCleanupTimer.current = null;
          }, 1_000);
        });
    },
    [
      captureVisibleAnchor,
      finishScrollAnchor,
      hasNewer,
      loadingNewer,
      onLoadNewer,
      reportVisibleMessages,
      scrollRef,
    ]
  );

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let previousTop = viewport.scrollTop;
    const onScroll = () => {
      const nextTop = viewport.scrollTop;
      if (!pendingScrollAnchor.current) {
        if (nextTop < previousTop - 1) viewportFill.current = "older-first";
        else if (nextTop > previousTop + 1) viewportFill.current = "newer-first";
      }
      previousTop = nextTop;
      // Keep the reading position even if navigation cancels the next frame.
      saveConversationScrollStateRef.current();
      scheduleViewportReport();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    scheduleViewportReport();
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [scheduleViewportReport, scrollRef]);

  useLayoutEffect(() => {
    void entries;
    void totalSize;
    scheduleViewportReport();
  }, [entries, scheduleViewportReport, totalSize]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !hasOlder || !onLoadOlder) return;
    let previousTop = viewport.scrollTop;
    const onScroll = () => {
      const nextTop = viewport.scrollTop;
      const movingTowardOlder = nextTop < previousTop - 1;
      previousTop = nextTop;
      if (movingTowardOlder && nextTop <= 600) loadOlder(true);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [hasOlder, loadOlder, onLoadOlder, scrollRef]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !hasNewer || !onLoadNewer) return;
    let previousTop = viewport.scrollTop;
    const onScroll = () => {
      const nextTop = viewport.scrollTop;
      const movingTowardNewer = nextTop > previousTop + 1;
      previousTop = nextTop;
      const bottomDistance = Math.max(0, viewport.scrollHeight - viewport.clientHeight - nextTop);
      if (movingTowardNewer && bottomDistance <= 600) loadNewer(true);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [hasNewer, loadNewer, onLoadNewer, scrollRef]);

  useLayoutEffect(() => {
    void totalSize;
    const anchor = pendingScrollAnchor.current;
    if (!anchor) return;
    const anchorIndex = entries.findIndex((entry) => `${entry.type}:${entry.id}` === anchor.key);
    if (anchorIndex < 0) {
      anchor.survived = false;
      finishScrollAnchor(anchor);
      return;
    }
    const restore = () => {
      if (pendingScrollAnchor.current !== anchor) return;
      scrollIndexToViewportOffset(anchorIndex, anchor.viewportOffset);
      sampleScrollAnchor(anchor);
    };
    const report = () => {
      if (pendingScrollAnchor.current !== anchor || anchor.reported) return;
      const error = sampleScrollAnchor(anchor);
      if (error === null) return;
      anchor.reported = true;
      recordPerformance("history.anchor.error-px", error, {
        automatic: anchor.automatic,
        direction: anchor.direction,
      });
      recordPerformance("history.page.intent-to-paint", performance.now() - anchor.startedAt, {
        automatic: anchor.automatic,
        direction: anchor.direction,
      });
    };
    restore();
    // Give ResizeObserver-driven row measurements two layout frames to settle.
    // Later measurements retrigger this effect through totalSize while the
    // short-lived anchor remains armed.
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      restore();
      secondFrame = window.requestAnimationFrame(() => {
        restore();
        report();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [entries, finishScrollAnchor, sampleScrollAnchor, scrollIndexToViewportOffset, totalSize]);

  useLayoutEffect(() => {
    if (!focus || !scrollInitialized) return;
    const key = `${focus.messageId}:${focus.nonce}`;
    if (focusWindowRef.current?.key !== key) {
      focusWindowRef.current = { key, expiresAt: performance.now() + 1_000 };
    } else if (performance.now() > focusWindowRef.current.expiresAt) {
      return;
    }
    // A search context is inserted while the conversation is still locked to
    // the newest message. Release that lock before the virtual list grows, or
    // use-stick-to-bottom's resize observer can immediately undo this jump.
    stopScroll();
    scrollToIndex(focus.index, { align: "center" });
    const timer = window.setTimeout(() => {
      const row = contentRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(focus.messageId)}"]`
      );
      if (!row) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({
        behavior: "auto",
        block: "center",
      });
      if (!reduceMotion) {
        row.animate(
          [
            { filter: "brightness(1)", transform: "translateZ(0)" },
            { filter: "brightness(0.88)", transform: "translateZ(0)" },
            { filter: "brightness(1)", transform: "translateZ(0)" },
          ],
          { duration: 760, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
        );
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focus, scrollInitialized, scrollToIndex, stopScroll, totalSize]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const cancelFocusWindow = () => {
      if (focusWindowRef.current) focusWindowRef.current.expiresAt = 0;
      pendingScrollAnchor.current = null;
    };
    viewport.addEventListener("wheel", cancelFocusWindow, { passive: true });
    viewport.addEventListener("touchstart", cancelFocusWindow, { passive: true });
    viewport.addEventListener("pointerdown", cancelFocusWindow, { passive: true });
    viewport.addEventListener("keydown", cancelFocusWindow);
    return () => {
      viewport.removeEventListener("wheel", cancelFocusWindow);
      viewport.removeEventListener("touchstart", cancelFocusWindow);
      viewport.removeEventListener("pointerdown", cancelFocusWindow);
      viewport.removeEventListener("keydown", cancelFocusWindow);
    };
  }, [scrollRef]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: Virtualization requires a single explicitly-sized positioning element.
    <div
      aria-label={`${entries.length} timeline entries`}
      className="relative w-full"
      data-virtual-timeline-count={entries.length}
      ref={contentRef}
      role="list"
      style={{ height: totalSize }}
    >
      {hasOlder && (
        <button
          className="sr-only focus:not-sr-only focus:absolute focus:left-1/2 focus:top-2 focus:z-20 focus:-translate-x-1/2 focus:rounded-full focus:bg-background focus:px-3 focus:py-1.5 focus:text-xs focus:shadow"
          disabled={loadingOlder}
          onClick={() => loadOlder(false)}
          type="button"
        >
          {loadingOlder ? "Loading older messages…" : "Load older messages"}
        </button>
      )}
      {hasNewer && (
        <button
          className="sr-only focus:not-sr-only focus:absolute focus:bottom-2 focus:left-1/2 focus:z-20 focus:-translate-x-1/2 focus:rounded-full focus:bg-background focus:px-3 focus:py-1.5 focus:text-xs focus:shadow"
          disabled={loadingNewer}
          onClick={() => loadNewer(false)}
          type="button"
        >
          {loadingNewer ? "Loading newer messages…" : "Load newer messages"}
        </button>
      )}
      {virtualItems.map((virtualItem) => {
        const entry = entries[virtualItem.index];
        if (!entry) return null;
        return (
          // biome-ignore lint/a11y/useSemanticElements: Virtual rows must remain measurable absolutely-positioned elements.
          <div
            aria-posinset={virtualItem.index + 1}
            aria-setsize={hasOlder || hasNewer ? -1 : entries.length}
            className="absolute inset-x-0 top-0 flex w-full flex-col gap-1 pb-1"
            data-virtual-timeline-index={virtualItem.index}
            data-virtual-timeline-key={virtualItem.key}
            key={virtualItem.key}
            ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
            role="listitem"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            {renderEntry(entry, virtualItem.index)}
          </div>
        );
      })}
    </div>
  );
}
