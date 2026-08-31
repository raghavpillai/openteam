// Source-owned adaptation of AI Elements conversation.tsx.
// Upstream: vercel/ai-elements@6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
import type { ComponentProps, ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export const Conversation = ({
  className,
  ...props
}: ComponentProps<typeof StickToBottom>) => (
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
  scrollClassName,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content
    className={cn(
      "mx-auto flex w-full max-w-4xl flex-col gap-6 py-8",
      className,
    )}
    scrollClassName={cn("conversation-scroll", scrollClassName)}
    {...props}
  />
);

const snapToTranscriptBottom = (viewport: HTMLElement) => {
  const snap = () => {
    if (viewport.isConnected) viewport.scrollTop = viewport.scrollHeight;
  };

  snap();
  queueMicrotask(snap);
  window.requestAnimationFrame(snap);
};

/** Positions a newly mounted transcript before the browser can paint it at the top. */
export const ConversationInitialBottom = () => {
  const { scrollRef } = useStickToBottomContext();

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) snapToTranscriptBottom(viewport);
  }, [scrollRef]);

  return null;
};

/** Snaps a newly added message into view during layout, before the next paint. */
export const ConversationNewMessageBottom = ({
  conversationId,
  messageCount,
  showTail,
}: {
  conversationId: string;
  messageCount: number;
  showTail: boolean;
}) => {
  const { isAtBottom, scrollRef } = useStickToBottomContext();
  const previousRef = useRef({
    conversationId,
    messageCount,
    showTail,
    wasAtBottom: isAtBottom,
  });

  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = {
      conversationId,
      messageCount,
      showTail,
      wasAtBottom: isAtBottom,
    };

    const hasNewTailContent =
      previous.conversationId === conversationId &&
      (messageCount > previous.messageCount ||
        (showTail && !previous.showTail));
    const viewport = scrollRef.current;
    if (!(hasNewTailContent && previous.wasAtBottom && viewport)) return;

    snapToTranscriptBottom(viewport);
  }, [conversationId, isAtBottom, messageCount, scrollRef, showTail]);

  return null;
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
        "pointer-events-none absolute inset-x-0 top-10 z-20 h-px bg-border transition-opacity duration-150 ease-out motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
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

export const ConversationScrollButton = ({
  bottomInset = 8,
  conversationId,
  messageCount,
}: {
  bottomInset?: number;
  conversationId: string;
  messageCount: number;
}) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const [scrolling, setScrolling] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const wasAtBottomRef = useRef(true);
  const previousMessagesRef = useRef({ conversationId, messageCount });
  const visible = !isAtBottom && !scrolling;

  useEffect(() => {
    const previous = previousMessagesRef.current;
    previousMessagesRef.current = { conversationId, messageCount };

    if (
      previous.conversationId !== conversationId ||
      messageCount <= previous.messageCount
    ) {
      setNewMessageCount(0);
      setNoticeDismissed(false);
      return;
    }

    if (!wasAtBottomRef.current) {
      setNewMessageCount(
        (count) => count + messageCount - previous.messageCount,
      );
      setNoticeDismissed(false);
    }
  }, [conversationId, messageCount]);

  useEffect(() => {
    wasAtBottomRef.current = isAtBottom;
    if (isAtBottom) {
      setNewMessageCount(0);
      setNoticeDismissed(false);
    }
  }, [isAtBottom]);

  const onClick = useCallback(async () => {
    setScrolling(true);
    setNewMessageCount(0);
    await scrollToBottom("instant");
    setScrolling(false);
  }, [scrollToBottom]);

  if (visible && newMessageCount > 0 && !noticeDismissed) {
    const label = `${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}`;
    return (
      <div
        className="absolute left-1/2 z-10 flex h-7 min-w-36 -translate-x-1/2 transform-gpu overflow-hidden rounded-full border text-sm font-normal transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none"
        style={{
          backgroundColor: "#3062bf",
          borderColor: "#2f5eb6",
          bottom: bottomInset,
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
      aria-label="Scroll to newest message"
      className={cn(
        "absolute left-1/2 z-10 size-8 -translate-x-1/2 transform-gpu rounded-full bg-[#fcfcfc] text-[#141414] transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform] hover:bg-[#fcfcfc] motion-reduce:transition-none dark:bg-[#2f2f2f] dark:text-[#fcfcfc] dark:hover:bg-[#2f2f2f]",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
      )}
      onClick={onClick}
      style={{
        bottom: bottomInset,
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
