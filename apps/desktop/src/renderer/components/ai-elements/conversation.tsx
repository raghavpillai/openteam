// Source-owned adaptation of AI Elements conversation.tsx.
// Upstream: vercel/ai-elements@6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
import type { ComponentProps, ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  StickToBottom,
  type StickToBottomContext,
  type StickToBottomState,
  useStickToBottomContext,
} from "use-stick-to-bottom";
import { ScrollArea } from "radix-ui";
import { cn } from "../../lib/cn";
import { recordPerformance } from "../../lib/performance";
import { Button } from "../ui/button";
import { useInitialConversationLayout } from "../../hooks/use-initial-conversation-layout";

// A critically damped spring with this response settles like an iMessage send:
// most of the distance in the first ~300ms, then a gentle arrival.
const GLIDE_OMEGA = (2 * Math.PI) / 0.42;
// Farther glides start this many viewports above the bottom. Animating through
// the whole transcript would mount and measure every intermediate virtual row.
const GLIDE_MAX_VIEWPORTS = 2.5;
const GLIDE_LEAD_VIEWPORTS = 1.5;
const GLIDE_INTERRUPTIONS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
// use-stick-to-bottom reports a reader this close to the end as at the bottom
// (and hides the newest-message controls), but stops following after any
// upward scroll. Arrivals within this band follow the transcript instead.
const NEAR_BOTTOM_FOLLOW_PX = 70;

const hasSelectionInside = (element: HTMLElement | null) => {
  const selection = window.getSelection();
  if (!element || !selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return element.contains(selection.getRangeAt(0).commonAncestorContainer);
};

const activeGlides = new WeakMap<StickToBottomState, () => void>();
const glideListeners = new WeakMap<StickToBottomState, Set<() => void>>();
const viewportSyncs = new WeakMap<StickToBottomState, () => void>();

const notifyGlide = (state: StickToBottomState) => {
  for (const listener of glideListeners.get(state) ?? []) listener();
};

/** True while a glide owns the scroll position; bottom-follow must not snap. */
export const isConversationGliding = (state: StickToBottomState) => activeGlides.has(state);

export const useConversationGliding = () => {
  const { state } = useStickToBottomContext();
  const subscribe = useCallback(
    (listener: () => void) => {
      let listeners = glideListeners.get(state);
      if (!listeners) glideListeners.set(state, (listeners = new Set()));
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [state]
  );
  return useSyncExternalStore(subscribe, () => activeGlides.has(state));
};

/**
 * Lets a virtualized transcript mount the rows at the viewport's current
 * scrollTop synchronously, so a long glide's starting position is never blank.
 */
export const registerConversationViewportSync = (state: StickToBottomState, sync: () => void) => {
  viewportSyncs.set(state, sync);
  return () => {
    if (viewportSyncs.get(state) === sync) viewportSyncs.delete(state);
  };
};

/**
 * Animates to the newest message and then locks to the bottom. The target is
 * read every frame, so rows that arrive or finish measuring mid-glide extend it
 * instead of being snapped to. `awaitGrowth` keeps following until the
 * transcript grows (a message that was just sent) or that wait times out.
 * Any wheel, touch, pointer or key input in the transcript cancels the glide.
 */
export const glideConversationToBottom = (
  context: StickToBottomContext,
  { awaitGrowth = 0 }: { awaitGrowth?: number } = {}
): Promise<boolean> => {
  const { scrollRef, state } = context;
  activeGlides.get(state)?.();
  const viewport = scrollRef.current;
  if (!viewport) return Promise.resolve(false);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve(context.scrollToBottom("instant"));
  }
  return new Promise((resolve) => {
    const root = viewport.closest<HTMLElement>('[role="log"]') ?? viewport;
    // use-stick-to-bottom treats one pixel above the maximum as the bottom.
    const bottom = () => Math.max(0, viewport.scrollHeight - 1 - viewport.clientHeight);
    const startedAt = performance.now();
    const startBottom = bottom();
    let position = viewport.scrollTop;
    let velocity = 0;
    let lastFrameAt = startedAt;
    let frame = 0;
    if (startBottom - position > viewport.clientHeight * GLIDE_MAX_VIEWPORTS) {
      position = startBottom - viewport.clientHeight * GLIDE_LEAD_VIEWPORTS;
      viewport.scrollTop = position;
      viewportSyncs.get(state)?.();
    }
    // While gliding, the library's notion of "bottom" is the glide position:
    // its resize-follow then cannot jump ahead, and it reports the reader as
    // being at the bottom so the newest-message controls stay hidden.
    const previousTarget = context.targetScrollTop;
    const glideTarget = () => position;
    context.targetScrollTop = glideTarget;
    const finish = (completed: boolean) => {
      window.cancelAnimationFrame(frame);
      for (const type of GLIDE_INTERRUPTIONS) root.removeEventListener(type, cancel);
      if (context.targetScrollTop === glideTarget) context.targetScrollTop = previousTarget;
      activeGlides.delete(state);
      notifyGlide(state);
      resolve(completed ? context.scrollToBottom("instant") : false);
    };
    const cancel = () => finish(false);
    for (const type of GLIDE_INTERRUPTIONS) root.addEventListener(type, cancel, { passive: true });
    activeGlides.set(state, cancel);
    notifyGlide(state);
    const step = (now: number) => {
      if (!viewport.isConnected) return finish(false);
      const seconds = Math.min(0.05, Math.max(0, now - lastFrameAt) / 1000);
      lastFrameAt = now;
      const target = bottom();
      // Exact critically damped step for this frame's duration: independent of
      // refresh rate, and velocity carries through a moving target.
      const offset = position - target;
      const decay = Math.exp(-GLIDE_OMEGA * seconds);
      const impulse = (velocity + GLIDE_OMEGA * offset) * seconds;
      velocity = (velocity - GLIDE_OMEGA * impulse) * decay;
      position = target + (offset + impulse) * decay;
      const settled = Math.abs(position - target) < 0.5 && Math.abs(velocity) < 30;
      if (settled) {
        position = target;
        velocity = 0;
      }
      if (Math.abs(viewport.scrollTop - position) >= 0.5) viewport.scrollTop = position;
      const waiting = target <= startBottom && now - startedAt < awaitGrowth;
      if (settled && !waiting) return finish(true);
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
  });
};

export const Conversation = ({ className, ...props }: ComponentProps<typeof StickToBottom>) => (
  <StickToBottom
    className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
);

export const ConversationContent = ({
  className,
  children,
  scrollClassName,
  overlayScrollbars = false,
  initialContentPending = false,
  warmLayout = false,
  ...props
}: ComponentProps<typeof StickToBottom.Content> & {
  overlayScrollbars?: boolean;
  initialContentPending?: boolean;
  /** Rows were already measured here, so the first paint can show them. */
  warmLayout?: boolean;
}) => {
  const [viewportReady, setViewportReady] = useState(false);
  const context = useStickToBottomContext();
  // Decided when the transcript mounts; later rows never change the gate. Rows
  // present at mount lay out synchronously; a page that arrives later is
  // measured across frames.
  const [requiredStableFrames] = useState(warmLayout ? 0 : initialContentPending ? 3 : 1);
  const layoutReady = useInitialConversationLayout(
    context.contentRef,
    context.scrollRef,
    viewportReady,
    initialContentPending,
    "",
    requiredStableFrames
  );
  const loading = !layoutReady && (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" role="status" aria-label="Loading messages">
      <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
    </div>
  );
  const layoutProps = {
    "aria-busy": !layoutReady,
    "aria-hidden": !layoutReady,
    "data-chat-layout-ready": layoutReady,
    inert: !layoutReady,
    style: { ...props.style, opacity: layoutReady ? 1 : 0 },
  };
  // Descendant layout effects run before the scrollport's ref is attached.
  // Mount the transcript in a second commit, still before the first paint, so
  // its virtualizer can measure and position against the real scrollport.
  useLayoutEffect(() => setViewportReady(true), []);
  if (overlayScrollbars) {
    return (
      <ScrollArea.Root type="hover" className="relative h-full w-full overflow-hidden">
        <ScrollArea.Viewport
          ref={context.scrollRef}
          className={cn("conversation-scroll conversation-overlay-scroll h-full w-full", scrollClassName)}
        >
          <div {...props} {...layoutProps} ref={context.contentRef} className={cn("mx-auto flex w-full max-w-4xl flex-col gap-6 py-8", className)}>
            {viewportReady ? (typeof children === "function" ? children(context) : children) : null}
          </div>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="conversation-overlay-bar">
          <ScrollArea.Thumb className="conversation-overlay-thumb" />
        </ScrollArea.Scrollbar>
        {loading}
      </ScrollArea.Root>
    );
  }
  return (
    <>
      <StickToBottom.Content
        className={cn("mx-auto flex w-full max-w-4xl flex-col gap-6 py-8", className)}
        scrollClassName={cn("conversation-scroll overflow-y-auto", scrollClassName)}
        {...props}
        {...layoutProps}
      >
        {viewportReady ? children : null}
      </StickToBottom.Content>
      {loading}
    </>
  );
};

export const ConversationTopDivider = () => {
  const { contentRef, scrollRef } = useStickToBottomContext();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!(viewport && content)) return;

    const update = () => {
      const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 1;
      setVisible(!hasOverflow || viewport.scrollTop > 1);
    };
    const resizeObserver = new ResizeObserver(update);

    viewport.addEventListener("scroll", update, { passive: true });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    update();

    return () => {
      viewport.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, [contentRef, scrollRef]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-11 z-20 h-px bg-border transition-opacity duration-150 ease-out motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0"
      )}
    />
  );
};

/**
 * Keeps the same part of the transcript visible while the composer grows.
 * The stick-to-bottom package observes transcript height, but the composer is
 * a sibling, so its growth changes the viewport height without triggering that
 * observer. Transferring that delta to scrollTop makes messages move upward
 * with the composer instead of being clipped by it.
 */
export const ConversationViewportAnchor = ({ active }: { active: boolean }) => {
  const { scrollRef } = useStickToBottomContext();
  const activeRef = useRef(active);

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    let previousHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = viewport.clientHeight;
      if (activeRef.current && nextHeight < previousHeight) {
        viewport.scrollTop += previousHeight - nextHeight;
      }
      previousHeight = nextHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef]);

  return null;
};

export const ConversationEmptyState = ({
  title = "Start a conversation",
  description = "This bot keeps one durable Pi session across restarts.",
  icon,
}: {
  title?: string;
  description?: string;
  icon?: ReactNode;
}) => (
  <div className="flex h-full min-h-80 flex-col items-center justify-center gap-2 text-center">
    {icon && <div className="mb-2 text-muted-foreground">{icon}</div>}
    <div className="text-base font-medium">{title}</div>
    <div className="max-w-sm text-sm text-muted-foreground">{description}</div>
  </div>
);

const ScrollDownIcon = ({ className }: { className: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path d="M12 3v16" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

const CloseIcon = () => (
  <svg
    aria-hidden="true"
    className="size-3.5"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const appendedTimelineEntryCount = ({
  previousCount,
  nextCount,
  previousLatestKey,
  nextLatestKey,
  previousLatestMessageKey = previousLatestKey,
  nextLatestMessageKey = nextLatestKey,
}: {
  previousCount: number;
  nextCount: number;
  previousLatestKey: string | null;
  nextLatestKey: string | null;
  previousLatestMessageKey?: string | null;
  nextLatestMessageKey?: string | null;
}) => {
  if (
    !previousLatestMessageKey ||
    !nextLatestMessageKey ||
    nextCount <= previousCount ||
    nextLatestMessageKey === previousLatestMessageKey
  )
    return 0;
  return nextCount - previousCount;
};

type ConversationNoticeSnapshot = {
  conversationId: string;
  messageCount: number;
  latestEntryKey: string | null;
  latestMessageKey: string | null;
  trackNewMessages: boolean;
};

export const conversationNoticeTransition = ({
  previous,
  next,
  trackNewMessages,
}: {
  previous: ConversationNoticeSnapshot;
  next: ConversationNoticeSnapshot;
  trackNewMessages: boolean;
}) => {
  if (
    !trackNewMessages ||
    !previous.trackNewMessages ||
    previous.conversationId !== next.conversationId
  ) {
    return { appendedCount: 0, reset: true };
  }

  return {
    appendedCount: appendedTimelineEntryCount({
      previousCount: previous.messageCount,
      nextCount: next.messageCount,
      previousLatestKey: previous.latestEntryKey,
      nextLatestKey: next.latestEntryKey,
      previousLatestMessageKey: previous.latestMessageKey,
      nextLatestMessageKey: next.latestMessageKey,
    }),
    reset: next.messageCount < previous.messageCount,
  };
};

type ConversationViewportFocusTarget = {
  focus: (options?: FocusOptions) => void;
  hasAttribute: (name: string) => boolean;
  tabIndex: number;
};

export const focusConversationViewport = (
  viewport: ConversationViewportFocusTarget | null
): boolean => {
  if (!viewport) return false;
  if (!viewport.hasAttribute("tabindex")) viewport.tabIndex = -1;
  viewport.focus({ preventScroll: true });
  return true;
};

export const ConversationScrollButton = ({
  conversationId,
  messageCount,
  latestEntryKey,
  authoritativeMessageCount,
  latestMessageKey,
  forceLatest = false,
  trackNewMessages = true,
  onAtBottomChange,
  onScrollToNewest,
}: {
  conversationId: string;
  messageCount: number;
  latestEntryKey: string | null;
  authoritativeMessageCount?: number;
  latestMessageKey?: string | null;
  forceLatest?: boolean;
  trackNewMessages?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  onScrollToNewest?: () => unknown;
}) => {
  const context = useStickToBottomContext();
  const { isAtBottom, scrollRef } = context;
  const gliding = useConversationGliding();
  const [scrolling, setScrolling] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const wasAtBottomRef = useRef(true);
  const contextRef = useRef(context);
  contextRef.current = context;
  const glidingRef = useRef(gliding);
  glidingRef.current = gliding;
  // Distance from the end where the reader last left the viewport. Appended
  // rows grow the transcript without a scroll event, so this is the position
  // before they arrived.
  const restingDistanceRef = useRef(0);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const update = () => {
      restingDistanceRef.current = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      );
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    return () => viewport.removeEventListener("scroll", update);
  }, [scrollRef]);
  const trackedMessageCount = authoritativeMessageCount ?? messageCount;
  const trackedLatestMessageKey = latestMessageKey ?? latestEntryKey;
  const previousMessagesRef = useRef({
    conversationId,
    messageCount: trackedMessageCount,
    latestEntryKey,
    latestMessageKey: trackedLatestMessageKey,
    trackNewMessages,
  });
  const visible = forceLatest || (!isAtBottom && !scrolling && !gliding);

  useEffect(() => {
    const previous = previousMessagesRef.current;
    const next = {
      conversationId,
      messageCount: trackedMessageCount,
      latestEntryKey,
      latestMessageKey: trackedLatestMessageKey,
      trackNewMessages,
    };
    previousMessagesRef.current = next;

    const transition = conversationNoticeTransition({
      previous,
      next,
      trackNewMessages,
    });
    if (transition.reset) {
      setNewMessageCount(0);
      setNoticeDismissed(false);
      return;
    }

    if (transition.appendedCount === 0) return;

    const current = contextRef.current;
    if (
      !current.state.isAtBottom &&
      !glidingRef.current &&
      restingDistanceRef.current <= NEAR_BOTTOM_FOLLOW_PX &&
      !hasSelectionInside(current.scrollRef.current)
    ) {
      void glideConversationToBottom(current);
      return;
    }

    if (!wasAtBottomRef.current) {
      setNewMessageCount((count) => count + transition.appendedCount);
      setNoticeDismissed(false);
    }
  }, [
    conversationId,
    latestEntryKey,
    trackNewMessages,
    trackedLatestMessageKey,
    trackedMessageCount,
  ]);

  useEffect(() => {
    // A glide is already heading to the newest message, including one that was
    // just sent; it must not be announced as unseen.
    wasAtBottomRef.current = isAtBottom || gliding;
    onAtBottomChange?.(isAtBottom);
    if (isAtBottom || gliding) {
      setNewMessageCount(0);
      setNoticeDismissed(false);
    }
  }, [gliding, isAtBottom, onAtBottomChange]);

  const onClick = useCallback(async () => {
    const jumpStartedAt = forceLatest ? performance.now() : null;
    const focusedViewport = scrollRef.current;
    focusConversationViewport(focusedViewport);
    setScrolling(true);
    setNewMessageCount(0);
    try {
      await onScrollToNewest?.();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (jumpStartedAt !== null) {
        recordPerformance("history.latest.jump-to-paint", performance.now() - jumpStartedAt);
      }
      await glideConversationToBottom(context);
    } catch {
      // The app-level operation already reports the failure. Keep the current
      // viewport instead of jumping within a stale history window.
    } finally {
      const currentViewport = scrollRef.current;
      if (
        currentViewport !== focusedViewport &&
        (document.activeElement === focusedViewport || document.activeElement === document.body)
      ) {
        focusConversationViewport(currentViewport);
      }
      setScrolling(false);
    }
  }, [context, forceLatest, onScrollToNewest, scrollRef]);

  if (visible && trackNewMessages && newMessageCount > 0 && !noticeDismissed) {
    const label = `${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}`;
    return (
      <div
        className="absolute bottom-2 left-1/2 z-10 flex h-7 min-w-36 -translate-x-1/2 transform-gpu overflow-hidden rounded-full border text-sm font-normal transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none"
        style={{
          bottom: "calc(8px + var(--composer-overlap, 0px))",
          backgroundColor: "#3062bf",
          borderColor: "#2f5eb6",
          boxShadow: "0 2px 5px rgba(0, 0, 0, 0.14)",
        }}
      >
        <button
          aria-label={`Scroll to ${label}`}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-l-full pl-1.5 text-[#fcfcfc] outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/50"
          onClick={onClick}
          type="button"
        >
          <ScrollDownIcon className="size-3.5 shrink-0" />
          <span className="whitespace-nowrap">{label}</span>
        </button>
        <button
          aria-label="Dismiss new message notification"
          className="flex size-7 shrink-0 items-center justify-center rounded-r-full text-[#c8d5ec] outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/50"
          onClick={() => setNoticeDismissed(true)}
          type="button"
        >
          <CloseIcon />
        </button>
      </div>
    );
  }

  return (
    <Button
      aria-hidden={!visible}
      aria-label={forceLatest ? "Jump to latest message" : "Scroll to newest message"}
      className={cn(
        "absolute bottom-2 left-1/2 z-10 size-8 -translate-x-1/2 transform-gpu rounded-full bg-[#fcfcfc] text-[#141414] transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform] hover:bg-[#fcfcfc] motion-reduce:transition-none dark:bg-[#2f2f2f] dark:text-[#fcfcfc] dark:hover:bg-[#2f2f2f]",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
      )}
      onClick={onClick}
      style={{
        bottom: "calc(8px + var(--composer-overlap, 0px))",
        boxShadow: "0 2px 5px rgba(0, 0, 0, 0.14)",
      }}
      tabIndex={visible ? 0 : -1}
      size="icon"
      variant="ghost"
    >
      <ScrollDownIcon className="size-5" />
    </Button>
  );
};
