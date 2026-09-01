import type {
  ApprovalDecision,
  ApprovalView,
  AssetRef,
  BotView,
  ChannelMessageView,
  ChannelView,
  ClientCapabilities,
  ClientSnapshot,
  RunItemView,
  RunView,
  SubagentActivityView,
} from "@openbot/contracts";
import {
  approvalPresentation,
  channelMessageAddress,
  type DurableSendPayload,
  type DurableSendRecord,
  durableSendIsInFlight,
  durableSendMessage,
  durableSendRenderKey,
  durableSendStatusLabel,
  messageAssets,
  messageDisplayProjection,
  messageMetadata,
  messageReactionPills,
  messageRenderKey,
  messageSenderLabel,
  ownReactionEmojiSet,
  replyTargetFor,
} from "@openbot/product-core";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  Ellipsis,
  File,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Reply,
  Smile,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import {
  Fragment,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { api } from "../../client/openbot-api";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import { a2aProjectionFor, collapseA2ATimeline } from "../../lib/a2a-events";
import {
  channelNameChangedEventFor,
  routineChangedActionLabel,
  routineChangedEventFor,
} from "../../lib/channel-events";
import { cn } from "../../lib/cn";
import {
  desktopDurableSendController,
  desktopSendTransportSnapshot,
  discardDesktopDeliveryStages,
  stageDesktopDeliveryFile,
  subscribeDesktopSendTransport,
} from "../../lib/durable-sends";
import { nextHistoryPageLoadStartedAt } from "../../lib/history-pagination";
import { type MentionOption, mentionHandleFor } from "../../lib/mentions";
import {
  formatIdleGapTimestamp,
  formatOfflineDeliveryLabel,
  shouldShowIdleGapTimestamp,
} from "../../lib/message-timestamps";
import { addContextGaps } from "../../lib/search-context";
import { conversationApprovals } from "../../lib/subagent-activity";
import { deriveThreads, isBranchedMessage } from "../../lib/threads";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  ConversationTopDivider,
  ConversationViewportAnchor,
} from "../ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { PromptInput } from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BotAvatar } from "./avatar";
import { EmojiPanel, EmojiPicker, MoreEmojiIcon, QUICK_REACTIONS } from "./emoji-picker";
import { MessageImageGallery } from "./image-attachment";
import { RichMessage } from "./rich-message";
import { ThreadTray } from "./thread-tray";

const MessageFileAttachments = lazy(() =>
  import("./file-attachment").then((module) => ({ default: module.MessageFileAttachments }))
);
const BotTemplateConversationFlow = lazy(() =>
  import("./bot-template-share").then((module) => ({
    default: module.BotTemplateConversationFlow,
  }))
);

const downloadAttachments = async (attachments: readonly AssetRef[]) =>
  (await import("./file-attachment")).downloadAttachments(attachments);

type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

interface ChatPaneProps {
  active?: boolean;
  agentNameById: ReadonlyMap<string, string>;
  channel: ChannelView;
  capabilities: ClientCapabilities;
  selectedBot?: BotView;
  messages: ChannelMessageView[];
  runs: RunView[];
  subagents: SubagentActivityView[];
  itemsByRun: ReadonlyMap<string, RunItemView[]>;
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>;
  botById: ReadonlyMap<string, BotView>;
  activeRun?: RunView;
  runtime: ClientSnapshot["runtime"];
  mutate: Mutate;
  threadContextMessageIds?: ReadonlySet<string>;
  searchContextMessageIds?: ReadonlySet<string>;
  activityTruncated?: boolean;
  threadContextTruncated?: boolean;
  focusMessage: { messageId: string; nonce: number } | null;
  historyMode?: "latest" | "history" | "context";
  hasOlder?: boolean;
  hasNewer?: boolean;
  hasNewerGap?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  onLoadOlder?: () => unknown;
  onLoadNewer?: () => unknown;
  onReactMessage?: (messageId: string, emoji: string) => Promise<unknown>;
  onScrollToNewest?: () => unknown;
  onViewportAtBottomChange?: (atBottom: boolean) => void;
  onCloseViewOnly?: () => void;
  onOpenA2A?: (sourceBotId: string, peerId: string, trigger: HTMLButtonElement) => void;
  onOpenRoutine?: (routineId: string) => void;
  templateShareRequest?: { botId: string; nonce: number } | null;
}

const runGroupsEqual = <T,>(
  runs: RunView[],
  previous: ReadonlyMap<string, T[]>,
  next: ReadonlyMap<string, T[]>
) => runs.every((run) => previous.get(run.id) === next.get(run.id));

const subagentApprovalGroupsEqual = (
  subagents: SubagentActivityView[],
  previous: ReadonlyMap<string, ApprovalView[]>,
  next: ReadonlyMap<string, ApprovalView[]>
) =>
  subagents.every(
    (subagent) =>
      !subagent.currentRunId ||
      previous.get(subagent.currentRunId) === next.get(subagent.currentRunId)
  );

const chatPanePropsEqual = (previous: ChatPaneProps, next: ChatPaneProps) =>
  previous.active === next.active &&
  previous.channel === next.channel &&
  previous.capabilities === next.capabilities &&
  previous.agentNameById === next.agentNameById &&
  previous.selectedBot === next.selectedBot &&
  previous.messages === next.messages &&
  previous.runs === next.runs &&
  previous.subagents === next.subagents &&
  previous.botById === next.botById &&
  previous.activeRun === next.activeRun &&
  previous.runtime === next.runtime &&
  previous.mutate === next.mutate &&
  previous.threadContextMessageIds === next.threadContextMessageIds &&
  previous.searchContextMessageIds === next.searchContextMessageIds &&
  previous.activityTruncated === next.activityTruncated &&
  previous.threadContextTruncated === next.threadContextTruncated &&
  previous.focusMessage === next.focusMessage &&
  previous.historyMode === next.historyMode &&
  previous.hasOlder === next.hasOlder &&
  previous.hasNewer === next.hasNewer &&
  previous.hasNewerGap === next.hasNewerGap &&
  previous.loadingOlder === next.loadingOlder &&
  previous.loadingNewer === next.loadingNewer &&
  previous.onLoadOlder === next.onLoadOlder &&
  previous.onLoadNewer === next.onLoadNewer &&
  previous.onReactMessage === next.onReactMessage &&
  previous.onScrollToNewest === next.onScrollToNewest &&
  previous.onViewportAtBottomChange === next.onViewportAtBottomChange &&
  previous.onCloseViewOnly === next.onCloseViewOnly &&
  previous.onOpenA2A === next.onOpenA2A &&
  previous.onOpenRoutine === next.onOpenRoutine &&
  previous.templateShareRequest === next.templateShareRequest &&
  runGroupsEqual(next.runs, previous.itemsByRun, next.itemsByRun) &&
  runGroupsEqual(next.runs, previous.approvalsByRun, next.approvalsByRun) &&
  subagentApprovalGroupsEqual(next.subagents, previous.approvalsByRun, next.approvalsByRun);

type MessageGroupPosition = "single" | "first" | "middle" | "last";
type ThinkingPhase = "hidden" | "visible" | "exiting";

const THINKING_EXIT_MS = 140;

const messagesShareGroup = (
  previous: ChannelMessageView | undefined,
  next: ChannelMessageView | undefined
) =>
  Boolean(
    previous &&
      next &&
      !a2aProjectionFor(previous) &&
      !a2aProjectionFor(next) &&
      !channelNameChangedEventFor(previous) &&
      !channelNameChangedEventFor(next) &&
      !routineChangedEventFor(previous) &&
      !routineChangedEventFor(next) &&
      previous.sender === next.sender &&
      (previous.sender !== "agent" || previous.senderBotId === next.senderBotId) &&
      !shouldShowIdleGapTimestamp(previous.createdAt, next.createdAt)
  );

const getMessageGroupPosition = (
  messages: ChannelMessageView[],
  index: number
): MessageGroupPosition => {
  const groupedWithPrevious = messagesShareGroup(messages[index - 1], messages[index]);
  const groupedWithNext = messagesShareGroup(messages[index], messages[index + 1]);

  if (groupedWithPrevious && groupedWithNext) return "middle";
  if (groupedWithPrevious) return "last";
  if (groupedWithNext) return "first";
  return "single";
};

const appendThinkingIndicatorToGroup = (
  position: MessageGroupPosition,
  seamedToThinkingIndicator: boolean
): MessageGroupPosition => {
  if (!seamedToThinkingIndicator) return position;
  if (position === "single") return "first";
  if (position === "last") return "middle";
  return position;
};

const useThinkingPresence = (active: boolean): ThinkingPhase => {
  const [phase, setPhase] = useState<ThinkingPhase>(active ? "visible" : "hidden");

  useEffect(() => {
    if (active) {
      setPhase("visible");
      return;
    }
    setPhase((current) => (current === "visible" ? "exiting" : current));
  }, [active]);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = window.setTimeout(() => {
      setPhase((current) => (current === "exiting" ? "hidden" : current));
    }, THINKING_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return active ? "visible" : phase;
};

const nextLocalMidnightDelay = (now: Date) => {
  const next = new Date(now);
  next.setHours(24, 0, 1, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
};

/** Timestamp labels only change when the local calendar day changes. */
const useDayClock = (active: boolean) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const schedule = () => {
      const current = new Date();
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, nextLocalMidnightDelay(current));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active]);
  return now;
};

const conversationScrollPositions = new Map<
  string,
  { bottomDistance: number; scrollTop: number }
>();

interface MessageTimelineEntry {
  type: "message";
  id: string;
  createdAt: string;
  message: ChannelMessageView;
  animateEntrance: boolean;
  pending: boolean;
  delivery: DurableSendRecord | null;
}

function VirtualizedTimeline<T extends { id: string; type: string }>({
  conversationId,
  entries,
  focus,
  hasOlder = false,
  hasNewer = false,
  loadingOlder = false,
  loadingNewer = false,
  onLoadOlder,
  onLoadNewer,
  renderEntry,
}: {
  conversationId: string;
  entries: T[];
  focus: { index: number; messageId: string; nonce: number } | null;
  hasOlder?: boolean;
  hasNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  onLoadOlder?: () => unknown;
  onLoadNewer?: () => unknown;
  renderEntry: (entry: T, index: number) => ReactNode;
}) {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const focusWindowRef = useRef<{ key: string; expiresAt: number } | null>(null);
  const initializedScroll = useRef(false);
  const loadingRequest = useRef(false);
  const lastOlderLoadStartedAt = useRef(0);
  const lastNewerLoadStartedAt = useRef(0);
  const anchorCleanupTimer = useRef<number | null>(null);
  const pendingScrollAnchor = useRef<{
    key: string;
    viewportOffset: number;
  } | null>(null);
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
  const { measureElement, scrollIndexToViewportOffset, scrollToIndex, totalSize, virtualItems } =
    useVirtualWindow({
      count: entries.length,
      activeIndex: focus?.index,
      estimateSize,
      getKey,
      scrollRef,
      initialAlign: "end",
      initialViewportSize: 900,
      maxItems: 80,
      overscan: 900,
      scopeRef: contentRef,
    });

  useLayoutEffect(() => {
    if (initializedScroll.current || entries.length === 0) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    initializedScroll.current = true;
    const stored = conversationScrollPositions.get(conversationId);
    viewport.scrollTop =
      stored && stored.bottomDistance > 2 ? stored.scrollTop : viewport.scrollHeight;
  }, [conversationId, entries.length, scrollRef, totalSize]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const save = () => {
      conversationScrollPositions.set(conversationId, {
        bottomDistance: Math.max(
          0,
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
        ),
        scrollTop: viewport.scrollTop,
      });
      if (conversationScrollPositions.size > 20) {
        conversationScrollPositions.delete(conversationScrollPositions.keys().next().value!);
      }
    };
    return save;
  }, [conversationId, scrollRef]);

  useEffect(
    () => () => {
      if (anchorCleanupTimer.current !== null) {
        window.clearTimeout(anchorCleanupTimer.current);
      }
    },
    []
  );

  const captureVisibleAnchor = useCallback(() => {
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
      key,
      viewportOffset: visibleRow.getBoundingClientRect().top - viewportBounds.top,
    };
    pendingScrollAnchor.current = anchor;
    stopScroll();
    return anchor;
  }, [scrollRef, stopScroll]);

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
      const anchor = captureVisibleAnchor();
      void Promise.resolve(onLoadOlder())
        .catch(() => {
          if (anchor && pendingScrollAnchor.current === anchor) pendingScrollAnchor.current = null;
        })
        .finally(() => {
          loadingRequest.current = false;
          anchorCleanupTimer.current = window.setTimeout(() => {
            if (anchor && pendingScrollAnchor.current === anchor) {
              pendingScrollAnchor.current = null;
            }
            anchorCleanupTimer.current = null;
          }, 1_000);
        });
    },
    [captureVisibleAnchor, hasOlder, loadingOlder, onLoadOlder, scrollRef]
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
      const anchor = captureVisibleAnchor();
      void Promise.resolve(onLoadNewer())
        .catch(() => {
          if (anchor && pendingScrollAnchor.current === anchor) pendingScrollAnchor.current = null;
        })
        .finally(() => {
          loadingRequest.current = false;
          anchorCleanupTimer.current = window.setTimeout(() => {
            if (anchor && pendingScrollAnchor.current === anchor) {
              pendingScrollAnchor.current = null;
            }
            anchorCleanupTimer.current = null;
          }, 1_000);
        });
    },
    [captureVisibleAnchor, hasNewer, loadingNewer, onLoadNewer, scrollRef]
  );

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
      pendingScrollAnchor.current = null;
      return;
    }
    const restore = () => {
      if (pendingScrollAnchor.current !== anchor) return;
      scrollIndexToViewportOffset(anchorIndex, anchor.viewportOffset);
    };
    restore();
    // Give ResizeObserver-driven row measurements two layout frames to settle.
    // Later measurements retrigger this effect through totalSize while the
    // short-lived anchor remains armed.
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      restore();
      secondFrame = window.requestAnimationFrame(restore);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [entries, scrollIndexToViewportOffset, totalSize]);

  useLayoutEffect(() => {
    if (!focus) return;
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
  }, [focus, scrollToIndex, stopScroll, totalSize]);

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
    <div
      aria-label={`${entries.length} timeline entries`}
      className="relative w-full"
      data-virtual-timeline-count={entries.length}
      ref={contentRef}
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

const messageImages = (message: ChannelMessageView) => {
  const canonical = messageAssets(message)
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      url: api.assetUrl(attachment),
      alt: attachment.alt ?? attachment.fileName,
    }));
  if (canonical.length > 0) return canonical;

  const legacyImages = messageMetadata(message).images;
  if (!Array.isArray(legacyImages)) return [];
  return legacyImages.flatMap((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) return [];
    const { url, alt } = image as Record<string, unknown>;
    if (
      typeof url !== "string" ||
      !(
        url.startsWith("/api/v0/assets/") ||
        url.startsWith("data:image/") ||
        url.startsWith("https://")
      )
    ) {
      return [];
    }
    return [{ url, ...(typeof alt === "string" ? { alt } : {}) }];
  });
};

const copyMessage = (message: ChannelMessageView) => {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(message.content).catch(() => undefined);
};

const copyRequestId = (message: ChannelMessageView) => {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(message.id).catch(() => undefined);
};

const DeliveryFooter = memo(function DeliveryFooter({
  delivery,
  onCancel,
  onDelete,
  onResend,
}: {
  delivery: DurableSendRecord | null;
  onCancel: (nonce: string) => Promise<void>;
  onDelete: (nonce: string) => Promise<void>;
  onResend: (nonce: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const transportDown = useSyncExternalStore(
    subscribeDesktopSendTransport,
    desktopSendTransportSnapshot,
    desktopSendTransportSnapshot
  );
  const currentOfflineAtMs = delivery?.queuedAtMs ?? null;
  const [retainedOfflineAtMs, setRetainedOfflineAtMs] = useState(currentOfflineAtMs);
  useEffect(() => {
    if (currentOfflineAtMs !== null) setRetainedOfflineAtMs(currentOfflineAtMs);
  }, [currentOfflineAtMs]);
  const act = (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void operation()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const actionClass =
    "rounded px-0.5 text-[11px] font-medium leading-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-50";
  if (delivery?.phase === "failed") {
    return (
      <div
        aria-label="Failed message actions"
        className="mt-1 flex flex-wrap items-center justify-end gap-1 self-end text-[11px] leading-4"
        data-failed-send-actions=""
        role="group"
      >
        <span className="font-medium text-destructive" role="status">
          {durableSendStatusLabel(delivery.phase)}
        </span>
        <button
          className={actionClass}
          disabled={busy}
          onClick={() => act(() => onResend(delivery.nonce))}
          type="button"
        >
          Resend
        </button>
        <button
          className={actionClass}
          disabled={busy}
          onClick={() => act(() => onDelete(delivery.nonce))}
          type="button"
        >
          Delete
        </button>
      </div>
    );
  }
  if (delivery?.phase === "queued") {
    return (
      <div
        className="mt-1 flex flex-wrap items-center justify-end gap-1 self-end text-[11px] leading-4 text-muted-foreground"
        data-queued-send-notice=""
        role="status"
      >
        <span>{durableSendStatusLabel(delivery.phase, transportDown)}</span>
        <button
          className={actionClass}
          disabled={busy}
          onClick={() => act(() => onCancel(delivery.nonce))}
          type="button"
        >
          Cancel
        </button>
      </div>
    );
  }
  const offlineAtMs = currentOfflineAtMs ?? retainedOfflineAtMs;
  if (
    offlineAtMs !== null &&
    ((delivery?.phase === "accepted-awaiting-echo" && currentOfflineAtMs !== null) ||
      (delivery === null && retainedOfflineAtMs !== null))
  ) {
    const clearing = delivery === null;
    return (
      <div
        aria-hidden={clearing || undefined}
        className="sent-while-offline-notice self-end text-[11px] leading-4 text-muted-foreground"
        data-cleared={clearing || undefined}
        data-sent-while-offline=""
        role="status"
      >
        {formatOfflineDeliveryLabel(offlineAtMs)}
      </div>
    );
  }
  return null;
});

const MessageRow = memo(function MessageRow({
  message,
  channel,
  senderBot,
  senderName,
  groupPosition,
  separatedFromPrevious,
  replyPreview,
  canInteract,
  onReply,
  onReact,
  onOpenThread,
  onOpenRoutine,
  threadReplyCount,
  animateEntrance,
  pending,
  delivery,
  onCancelSend,
  onDeleteSend,
  onResendSend,
}: {
  message: ChannelMessageView;
  channel: ChannelView;
  senderBot?: BotView;
  senderName?: string;
  groupPosition: MessageGroupPosition;
  separatedFromPrevious: boolean;
  replyPreview?: { content: string; senderLabel: string } | null;
  canInteract: boolean;
  onReply: (message: ChannelMessageView) => void;
  onReact: (message: ChannelMessageView, emoji: string) => void;
  onOpenThread: (message: ChannelMessageView) => void;
  onOpenRoutine?: (routineId: string) => void;
  threadReplyCount: number;
  animateEntrance: boolean;
  pending: boolean;
  delivery: DurableSendRecord | null;
  onCancelSend: (nonce: string) => Promise<void>;
  onDeleteSend: (nonce: string) => Promise<void>;
  onResendSend: (nonce: string) => Promise<void>;
}) {
  const [entranceActive, setEntranceActive] = useState(animateEntrance);
  const channelEvent = channelNameChangedEventFor(message);
  const routineEvent = routineChangedEventFor(message);
  const from =
    message.sender === "user" ? "user" : message.sender === "system" ? "system" : "assistant";
  const hasAgentGutter = message.sender === "agent" && channel.kind !== "bot_dm";
  const showAgentAvatar =
    hasAgentGutter && (groupPosition === "single" || groupPosition === "last");
  const a2aProjection = channel.kind === "bot_dm" ? a2aProjectionFor(message) : null;
  const userReactionSet = ownReactionEmojiSet(message);
  const display = messageDisplayProjection(message);
  const { attachments, stagedAttachments, displayContent, files: fileAttachments } = display;
  const stagedImageAttachments = stagedAttachments.filter(
    (attachment) => attachment.kind === "image" && attachment.previewUri
  );
  const stagedFileAttachments = stagedAttachments.filter(
    (attachment) => attachment.kind !== "image" || !attachment.previewUri
  );
  const images = [
    ...messageImages(message),
    ...stagedImageAttachments.map((attachment) => ({
      url: attachment.previewUri as string,
      alt: attachment.alt ?? attachment.fileName,
    })),
  ];
  const reactionPills = messageReactionPills(message);
  const previousReactionKeys = useRef<ReadonlySet<string> | null>(null);
  const newReactionKeys = new Set(
    previousReactionKeys.current
      ? reactionPills
          .filter(({ emoji }) => !previousReactionKeys.current?.has(emoji))
          .map(({ emoji }) => emoji)
      : []
  );
  useEffect(() => {
    previousReactionKeys.current = new Set(reactionPills.map(({ emoji }) => emoji));
  }, [reactionPills]);
  if (channelEvent) {
    return (
      <div
        className={`flex justify-center px-5 pb-3 pt-2 text-xs leading-5 text-muted-foreground${
          separatedFromPrevious ? " mt-3" : ""
        }`}
        data-channel-event="name-changed"
        data-message-id={message.id}
      >
        Renamed to {channelEvent.to}
      </div>
    );
  }
  if (routineEvent) {
    return (
      <div
        className={`flex min-h-8 items-center justify-center gap-1 px-5 pb-3 pt-2 text-[12px] leading-5 text-muted-foreground${
          separatedFromPrevious ? " mt-3" : ""
        }`}
        data-channel-event="automation-changed"
        data-message-id={message.id}
      >
        <span>{routineChangedActionLabel(routineEvent.action)}</span>
        <button
          aria-label={`Open routine ${routineEvent.automationName}`}
          className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full px-1.5 outline-none transition-colors hover:bg-[#f1f1f1] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-[#252525]"
          data-routine-event-link=""
          onClick={() => onOpenRoutine?.(routineEvent.automationId)}
          title={routineEvent.automationName}
          type="button"
        >
          <Clock3 className="size-3 shrink-0" strokeWidth={1.7} />
          <span className="max-w-[240px] truncate">{routineEvent.automationName}</span>
        </button>
      </div>
    );
  }
  const actions = (
    <MessageActions
      className={`pointer-events-none shrink-0 opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 ${
        from === "user" ? "flex-row-reverse" : ""
      }`}
    >
      <EmojiPicker
        compactFirst
        onSelect={(emoji) => onReact(message, emoji)}
        selectedEmojis={userReactionSet}
      >
        <button
          aria-label="React to message"
          className="flex size-6 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          disabled={!canInteract}
          type="button"
        >
          <Smile className="size-[15px]" />
        </button>
      </EmojiPicker>
      <MessageAction
        className="size-6 rounded-full"
        disabled={!canInteract}
        onClick={() => onReply(message)}
        tooltip="Reply"
      >
        <Reply className="size-[15px]" />
      </MessageAction>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="More message actions"
            className="flex size-6 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            type="button"
          >
            <Ellipsis className="size-[15px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={from === "user" ? "end" : "start"}
          className="w-[156px] min-w-0"
        >
          <DropdownMenuItem className="h-8 text-[13px]" onSelect={() => copyMessage(message)}>
            <Copy className="size-3.5" /> Copy
          </DropdownMenuItem>
          {from === "user" && (
            <DropdownMenuItem className="h-8 text-[13px]" onSelect={() => copyRequestId(message)}>
              <Copy className="size-3.5" /> Copy request ID
            </DropdownMenuItem>
          )}
          {attachments.length > 1 && (
            <DropdownMenuItem
              className="h-8 text-[13px]"
              onSelect={() => void downloadAttachments(attachments)}
            >
              <Download className="size-3.5" /> Download all
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </MessageActions>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Message
          className={`group/message${separatedFromPrevious ? " mt-3" : ""}`}
          data-enter={entranceActive ? "new" : undefined}
          data-message-address={channelMessageAddress(message)}
          data-message-id={message.id}
          data-failed={delivery?.phase === "failed" || undefined}
          data-pending={pending || undefined}
          from={from}
          onAnimationEnd={(event) => {
            if (
              event.animationName === "message-row-enter" ||
              event.animationName === "message-row-enter-reduced"
            ) {
              setEntranceActive(false);
            }
          }}
        >
          {a2aProjection && (
            <div className="flex items-center gap-1.5 px-1 pt-2 text-xs font-medium text-muted-foreground">
              <MessageCircle className="size-3.5" />
              <span>
                {a2aProjection.direction === "incoming" ? "Message from" : "Messaged"}{" "}
                {a2aProjection.peerName ?? (senderBot?.name || "another agent")}
              </span>
            </div>
          )}
          {message.sender === "agent" &&
            channel.kind !== "bot_dm" &&
            groupPosition !== "middle" &&
            groupPosition !== "last" && (
              <div
                className="pl-[46px] pt-2 text-xs leading-5 text-muted-foreground"
                data-message-agent-name=""
              >
                <span>{senderName ?? senderBot?.name ?? "Bot"}</span>
              </div>
            )}
          {replyPreview && (
            <div
              className={`flex max-w-[min(88%,640px,calc(100%-82px))] items-center gap-1.5 px-2 pb-0.5 text-xs text-muted-foreground ${
                from === "user" ? "self-end" : "self-start"
              }`}
            >
              <Reply className="size-3 shrink-0" />
              <span className="shrink-0 font-medium">{replyPreview.senderLabel}</span>
              <span className="truncate">{replyPreview.content}</span>
            </div>
          )}
          <div
            className={`flex w-full max-w-full ${hasAgentGutter ? "gap-[5px]" : "gap-2"} ${
              images.length > 0 || fileAttachments.length > 0 || stagedFileAttachments.length > 0
                ? "items-end"
                : "items-center"
            } ${from === "user" ? "justify-end" : "justify-start"}`}
          >
            {from === "user" && actions}
            {hasAgentGutter && (
              <div
                className="flex w-6 shrink-0 self-stretch items-end justify-center"
                data-message-agent-gutter=""
              >
                {showAgentAvatar && <BotAvatar bot={senderBot} size="sm" />}
              </div>
            )}
            {display.richMessage ? (
              <RichMessage message={message} />
            ) : images.length > 0 ||
              fileAttachments.length > 0 ||
              stagedFileAttachments.length > 0 ? (
              <div
                className={`flex max-w-[min(88%,640px,calc(100%-82px))] flex-col gap-1.5 ${
                  from === "user" ? "items-end" : "items-start"
                }`}
                data-message-bubble-id={message.id}
              >
                <MessageImageGallery images={images} />
                {fileAttachments.length > 0 && (
                  <Suspense fallback={null}>
                    <MessageFileAttachments attachments={fileAttachments} />
                  </Suspense>
                )}
                {stagedFileAttachments.map((attachment) => (
                  <article
                    className="flex h-[52px] w-[246px] max-w-full items-center gap-2 rounded-[12px] border border-black/10 bg-background px-3 dark:border-white/15"
                    data-staged-attachment=""
                    key={attachment.stagingId}
                  >
                    <File className="size-[17px] shrink-0 text-foreground-secondary" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {attachment.fileName}
                    </span>
                  </article>
                ))}
                {displayContent && (
                  <MessageContent
                    className="max-w-full"
                    data-group-position={groupPosition}
                    from={from}
                  >
                    <MessageResponse>{displayContent}</MessageResponse>
                  </MessageContent>
                )}
              </div>
            ) : (
              <MessageContent
                data-group-position={groupPosition}
                data-message-bubble-id={message.id}
                from={from}
              >
                <MessageResponse>{message.content}</MessageResponse>
              </MessageContent>
            )}
            {from !== "user" && actions}
          </div>
          {(reactionPills.length > 0 || userReactionSet.size > 0) && (
            <div
              className={`relative -mt-2 flex flex-row flex-wrap gap-1 ${
                from === "user" ? "ml-auto mr-2.5 self-end justify-end" : "ml-2.5 self-start"
              }`}
            >
              {reactionPills.map(({ emoji, count }) => {
                const selected = userReactionSet.has(emoji);
                return (
                  <button
                    aria-label={`${selected ? "Remove" : "Add"} ${emoji} reaction`}
                    aria-pressed={selected}
                    className={`inline-flex h-[22px] origin-center items-center gap-[3px] rounded-full border-0 py-0 pl-[7px] pr-2 text-xs leading-4 tabular-nums text-[#666] shadow-[0_0_0_2px_#fcfcfc] transition-[transform,background-color] duration-[120ms] active:scale-95 disabled:cursor-default dark:text-[rgba(240,240,240,0.74)] dark:shadow-[0_0_0_2px_#070707] ${
                      newReactionKeys.has(emoji) ? "reaction-pill-enter" : ""
                    } ${
                      selected
                        ? "bg-[#e5f0ff] hover:bg-[#d9eaff] dark:bg-[#1a2e55] dark:hover:bg-[#1e3b69]"
                        : "bg-[#f3f3f3] hover:bg-[#ececec] dark:bg-[#202020] dark:hover:bg-[#292929]"
                    }`}
                    disabled={!canInteract}
                    key={emoji}
                    onClick={() => onReact(message, emoji)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="reaction-emoji text-[14px] leading-none text-foreground"
                    >
                      {emoji}
                    </span>
                    {count > 1 && <span>{count}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {threadReplyCount > 0 && (
            <button
              className={`mt-0.5 inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground ${
                from === "user" ? "self-end" : "self-start"
              }`}
              data-thread-summary-id={message.id}
              onClick={() => onOpenThread(message)}
              type="button"
            >
              <MessageCircle className="size-3.5" />
              {threadReplyCount} {threadReplyCount === 1 ? "reply" : "replies"}
            </button>
          )}
          <DeliveryFooter
            delivery={delivery}
            onCancel={onCancelSend}
            onDelete={onDeleteSend}
            onResend={onResendSend}
          />
        </Message>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[246px]">
        {canInteract && (
          <>
            <div className="flex items-center gap-0.5 px-1 py-0.5">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  aria-label={`React with ${emoji}`}
                  className={`flex size-[30px] items-center justify-center rounded-lg text-[20px] hover:bg-accent ${
                    userReactionSet.has(emoji) ? "bg-accent ring-1 ring-input" : ""
                  }`}
                  key={emoji}
                  onClick={() => {
                    onReact(message, emoji);
                  }}
                  type="button"
                >
                  {emoji}
                </button>
              ))}
              <ContextMenuSub>
                <ContextMenuSubTrigger
                  aria-label="Open emoji picker"
                  className="size-[30px] justify-center gap-0 p-0"
                >
                  <MoreEmojiIcon />
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-[296px] p-0">
                  <EmojiPanel
                    onSelect={(emoji) => {
                      onReact(message, emoji);
                    }}
                    selectedEmojis={userReactionSet}
                  />
                </ContextMenuSubContent>
              </ContextMenuSub>
            </div>
            <ContextMenuSeparator className="my-0.5" />
            <ContextMenuItem onSelect={() => onReply(message)}>
              <Reply className="size-4" /> Reply
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem onSelect={() => copyMessage(message)}>
          <Copy className="size-4" /> Copy
        </ContextMenuItem>
        {from === "user" && (
          <ContextMenuItem onSelect={() => copyRequestId(message)}>
            <Copy className="size-4" /> Copy request ID
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

const approvalCardClass =
  "flex w-full min-w-0 flex-col gap-3 rounded-2xl bg-[#eeeeee] p-3 text-[13px] text-[#141414] dark:bg-[#262626] dark:text-[#f0f0f0]";
const approvalContentClass = "flex w-full min-w-0 flex-col items-start gap-1";
const approvalTitleClass =
  "min-w-0 flex-1 text-[14px] font-medium leading-[22px] text-[#141414] dark:text-[#f0f0f0]";
const approvalSecondaryTextClass = "text-[#141414]/[0.74] dark:text-[#f0f0f0]/[0.74]";
const approvalButtonClass = "h-8 rounded-lg px-2.5 py-0 text-[14px] leading-[22px] shadow-none";
const approvalPrimaryButtonClass = cn(
  approvalButtonClass,
  "bg-[#141414] text-[#fcfcfc] hover:bg-[#141414]/[0.74] dark:bg-[#f0f0f0] dark:text-[#181818] dark:hover:bg-[#f0f0f0]/[0.74]"
);
const approvalSecondaryButtonClass = cn(
  approvalButtonClass,
  "border-[#141414]/[0.08] bg-[#141414]/[0.04] text-[#141414] hover:bg-[#141414]/[0.14] hover:text-[#141414] dark:border-[#f0f0f0]/[0.08] dark:bg-[#f0f0f0]/[0.04] dark:text-[#f0f0f0] dark:hover:bg-[#f0f0f0]/[0.14] dark:hover:text-[#f0f0f0]"
);

const isLocalApproval = (approval: ApprovalView) =>
  approvalPresentation(approval).kind === "local-tool";

const isPendingLocalApproval = (approval: ApprovalView) =>
  approval.status === "pending" && isLocalApproval(approval);

const isResolvedLocalApproval = (approval: ApprovalView) =>
  approval.status !== "pending" && isLocalApproval(approval);

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: ApprovalDecision) => Promise<void>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const presentation = approvalPresentation(approval);
  const {
    details,
    detailsLabel,
    effect,
    heading,
    machineLabel,
    pending,
    proposedRule,
    rawDetails,
    reason,
    resolution,
    reviewSummary,
    statusLabel,
    supportsAlwaysAllow,
    supportsNever,
    taskReview,
    visibleArguments,
  } = presentation;
  useEffect(() => {
    if (!pending) setDetailsOpen(false);
  }, [pending]);
  const localTool = presentation.kind === "local-tool";
  const autoReview = presentation.kind === "auto-review";

  if (localTool) {
    if (!pending) {
      return (
        <div
          aria-label="Local tool permission result"
          className={cn(
            "min-h-6 w-full min-w-0 truncate text-center text-[12px] leading-4",
            approvalSecondaryTextClass
          )}
          data-approval-id={approval.id}
          data-approval-status={approval.status}
          data-local-tool-permission-result=""
          title={statusLabel}
        >
          {statusLabel}
        </div>
      );
    }

    return (
      <div
        aria-label="Local tool permission"
        className={approvalCardClass}
        data-approval-id={approval.id}
        data-approval-status={approval.status}
        data-local-tool-permission=""
      >
        <div className={approvalContentClass}>
          <div className="flex w-full min-w-0 items-start gap-2">
            <span className="inline-flex h-[22px] shrink-0 items-center">
              <TriangleAlert
                aria-hidden="true"
                className="size-4 text-[#d08770]"
                strokeWidth={1.75}
              />
            </span>
            <div className={approvalTitleClass}>{effect ?? heading}</div>
            <button
              aria-label="Deny once"
              className="grid size-5 shrink-0 place-items-center rounded-md text-[#141414]/60 outline-none hover:bg-[#141414]/[0.04] hover:text-[#141414] focus-visible:ring-2 focus-visible:ring-ring/30 dark:text-[#f0f0f0]/60 dark:hover:bg-[#f0f0f0]/[0.04] dark:hover:text-[#f0f0f0]"
              onClick={() => void onResolve("decline")}
              type="button"
            >
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </div>

          <div
            className={cn(
              "text-[12px] font-medium leading-4 [overflow-wrap:anywhere]",
              approvalSecondaryTextClass
            )}
          >
            {machineLabel}
          </div>
          <div
            className={cn(
              "text-[13px] leading-[18px] [overflow-wrap:anywhere]",
              approvalSecondaryTextClass
            )}
          >
            {"This applies to OpenBot and every Bot. It can always be changed in Settings."}
          </div>

          {rawDetails ? (
            <ApprovalDetails
              detailsLabel={detailsLabel}
              open={detailsOpen}
              rawDetails={rawDetails}
              setOpen={setDetailsOpen}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {supportsAlwaysAllow ? (
            <Button
              className={approvalPrimaryButtonClass}
              onClick={() => void onResolve("always_allow")}
            >
              Always allow
            </Button>
          ) : null}
          <Button
            className={approvalSecondaryButtonClass}
            onClick={() => void onResolve("accept")}
            variant="outline"
          >
            Allow once
          </Button>
          {supportsNever ? (
            <Button
              className={approvalSecondaryButtonClass}
              onClick={() => void onResolve("never")}
              variant="outline"
            >
              Never
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (autoReview) {
    return (
      <div
        aria-label="Auto-review approval"
        className={approvalCardClass}
        data-approval-id={approval.id}
        data-approval-status={approval.status}
        data-auto-review-approval=""
      >
        <div className={approvalContentClass}>
          <div className="flex w-full min-w-0 items-start gap-2">
            <div className={approvalTitleClass}>{presentation.title}</div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-medium leading-[18px]",
                pending
                  ? "gap-1 bg-[#f1b467]/[0.22] pl-1 text-[#f1b467]"
                  : approval.status === "declined"
                    ? "bg-[#fc6b83]/[0.12] text-[#fc6b83]"
                    : "text-[#141414] dark:text-[#f0f0f0]"
              )}
            >
              {pending ? (
                <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.7} />
              ) : approval.status === "declined" ? (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              ) : null}
              {statusLabel}
            </span>
          </div>

          {!taskReview ? (
            <>
              <div
                className={cn(
                  "text-[12px] font-medium leading-4 [overflow-wrap:anywhere]",
                  approvalSecondaryTextClass
                )}
              >
                Runs on your local computer
              </div>
              <div className="text-[13px] leading-[1.45] text-[#141414] [overflow-wrap:anywhere] dark:text-[#f0f0f0]">
                {reviewSummary}
              </div>
            </>
          ) : null}
          {pending && reason ? (
            <div
              className={cn(
                "text-[13px] leading-[18px] [overflow-wrap:anywhere]",
                approvalSecondaryTextClass
              )}
            >
              {reason}
            </div>
          ) : null}

          {rawDetails ? (
            <ApprovalDetails
              detailsLabel={detailsLabel}
              open={detailsOpen}
              rawDetails={rawDetails}
              setOpen={setDetailsOpen}
            />
          ) : null}
          {!pending && resolution === "always_allow" ? (
            <div
              className={cn(
                "text-[13px] leading-[18px] [overflow-wrap:anywhere]",
                approvalSecondaryTextClass
              )}
            >
              {`A rule always allowing this was added to your Auto-review settings${
                proposedRule ? `: “${proposedRule}”` : ""
              }`}
            </div>
          ) : null}
        </div>

        {pending ? (
          <div className="flex flex-wrap gap-2">
            <Button className={approvalPrimaryButtonClass} onClick={() => void onResolve("accept")}>
              Allow once
            </Button>
            {supportsAlwaysAllow ? (
              <Button
                className={approvalSecondaryButtonClass}
                onClick={() => void onResolve("always_allow")}
                variant="outline"
              >
                Always allow
              </Button>
            ) : null}
            <Button
              className={approvalSecondaryButtonClass}
              onClick={() => void onResolve("decline")}
              variant="outline"
            >
              Deny
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-sm"
      data-approval-id={approval.id}
      data-approval-status={approval.status}
    >
      <div className="mb-2 flex items-center gap-2 font-medium">
        {pending ? (
          <CircleAlert className="size-4 text-amber-500" />
        ) : (
          <Check className="size-4 text-foreground-secondary" />
        )}
        {pending ? (localTool ? effect : heading) : statusLabel}
      </div>
      {pending && localTool ? (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          {typeof details.machineLabel === "string" ? details.machineLabel : "This computer"}. This
          applies to OpenBot and every Bot and can be changed in Settings.
        </p>
      ) : !localTool && effect ? (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">{effect}</p>
      ) : null}
      {visibleArguments && typeof visibleArguments === "object" ? (
        <pre className="mb-3 max-h-40 overflow-auto rounded-lg bg-black/[0.04] p-2 whitespace-pre-wrap text-[11px] text-muted-foreground dark:bg-white/[0.05]">
          {JSON.stringify(visibleArguments, null, 2)}
        </pre>
      ) : null}
      {pending && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void onResolve("decline")} size="sm" variant="outline">
            Deny once
          </Button>
          {supportsAlwaysAllow ? (
            <Button onClick={() => void onResolve("always_allow")} size="sm" variant="outline">
              Always allow
            </Button>
          ) : null}
          <Button onClick={() => void onResolve("accept")} size="sm">
            <Check className="size-3.5" /> Allow once
          </Button>
          {supportsNever ? (
            <Button onClick={() => void onResolve("never")} size="sm" variant="outline">
              Never
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ApprovalDetails({
  detailsLabel,
  open,
  rawDetails,
  setOpen,
}: {
  detailsLabel: string;
  open: boolean;
  rawDetails: string;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 self-start text-[13px] leading-[18px] outline-none hover:text-[#141414] focus-visible:ring-2 focus-visible:ring-ring/30 dark:hover:text-[#f0f0f0]",
          approvalSecondaryTextClass
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3.5" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="size-3.5" strokeWidth={1.75} />
        )}
        {open ? `Hide the ${detailsLabel}` : `Show the ${detailsLabel}`}
      </button>
      {open ? (
        <div className="approval-code-figure relative w-full min-w-0 rounded-lg bg-[#141414]/[0.04] dark:bg-[#f0f0f0]/[0.04]">
          <pre
            className={cn(
              "grok-scrollbar max-h-40 overflow-auto whitespace-pre px-3 py-2 font-mono text-[13px] leading-5",
              approvalSecondaryTextClass
            )}
          >
            {rawDetails}
          </pre>
          <button
            aria-label="Copy code"
            className="approval-copy-button absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md border-[0.5px] border-[#141414]/[0.08] bg-[#fcfcfc] text-[#141414]/60 shadow-[0_1px_3px_#0000001f] outline-none hover:bg-[#f7f7f7] hover:text-[#141414] focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-[#f0f0f0]/[0.08] dark:bg-[#383838] dark:text-[#f0f0f0]/60 dark:hover:bg-[#444] dark:hover:text-[#f0f0f0]"
            onClick={() => void navigator.clipboard.writeText(rawDetails)}
            type="button"
          >
            <Copy className="size-3.5" strokeWidth={1.7} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

const BotThinkingSlot = memo(function BotThinkingSlot({
  bot,
  phase,
}: {
  bot?: BotView;
  phase: ThinkingPhase;
}) {
  const name = bot?.name ?? "Bot";
  const mounted = phase !== "hidden";
  return (
    <div
      aria-hidden={!mounted}
      className="flex h-9 shrink-0 items-center"
      data-active={phase === "visible" || undefined}
      data-bot-thinking-slot=""
      data-phase={phase}
      data-timeline-entry="thinking"
    >
      {mounted ? (
        <div
          aria-label={`${name} is working`}
          aria-hidden={phase === "exiting" || undefined}
          className="bot-thinking-content flex min-w-0 items-center gap-2"
          data-bot-thinking=""
          data-exiting={phase === "exiting" || undefined}
          role="status"
        >
          <span aria-hidden="true" className="bot-thinking-badge">
            <span className="bot-thinking-dot" />
            <span className="bot-thinking-dot" />
            <span className="bot-thinking-dot" />
          </span>
          <span className="bot-thinking-label min-w-0 truncate whitespace-nowrap text-[14px] leading-5">
            {name} is working
          </span>
        </div>
      ) : null}
    </div>
  );
});

const A2AActivityRow = memo(function A2AActivityRow({
  count,
  onOpen,
  peer,
  peerName,
}: {
  count: number;
  onOpen?: (trigger: HTMLButtonElement) => void;
  peer?: BotView;
  peerName: string;
}) {
  const name = peer?.name ?? peerName;
  const peerContent = (
    <>
      <BotAvatar bot={peer} size="activity" />
      <span className="truncate">{name}</span>
    </>
  );
  return (
    <div
      className="mx-auto mt-2 flex h-6 items-center gap-1.5 px-2 text-xs text-muted-foreground dark:text-[#9a9a9a]"
      data-a2a-activity=""
    >
      <span className="leading-5">
        {count} {count === 1 ? "message" : "messages"} with
      </span>
      {onOpen ? (
        <button
          aria-label={`Open A2A exchange with ${name}`}
          className="inline-flex h-6 max-w-[min(320px,55vw)] items-center gap-1 rounded-full bg-transparent pl-1 pr-2 leading-5 text-inherit transition-colors hover:bg-[#efefef] focus-visible:bg-[#efefef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:hover:bg-[#1b1b1b] dark:focus-visible:bg-[#1b1b1b]"
          data-a2a-peer-pill=""
          onClick={(event) => onOpen(event.currentTarget)}
          type="button"
        >
          {peerContent}
        </button>
      ) : (
        <span
          className="inline-flex h-6 max-w-[min(320px,55vw)] items-center gap-1 rounded-full bg-transparent pl-1 pr-2 leading-5"
          data-a2a-peer-pill=""
        >
          {peerContent}
        </span>
      )}
    </div>
  );
});

export const ChatPane = memo(function ChatPane({
  active = true,
  agentNameById,
  channel,
  capabilities,
  selectedBot,
  messages,
  runs,
  subagents,
  approvalsByRun,
  botById,
  activeRun,
  runtime,
  mutate,
  threadContextMessageIds,
  searchContextMessageIds,
  activityTruncated = false,
  threadContextTruncated = false,
  focusMessage,
  historyMode = "latest",
  hasOlder,
  hasNewer,
  hasNewerGap = false,
  loadingOlder,
  loadingNewer,
  onLoadOlder,
  onLoadNewer,
  onReactMessage,
  onScrollToNewest,
  onViewportAtBottomChange,
  onCloseViewOnly,
  onOpenA2A,
  onOpenRoutine,
  templateShareRequest,
}: ChatPaneProps) {
  const now = useDayClock(active);
  const [replyTarget, setReplyTarget] = useState<{
    channelId: string;
    messageId: string;
  } | null>(null);
  const [pendingAttachmentCount, setPendingAttachmentCount] = useState(0);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const fileDropTargetRef = useRef<HTMLDivElement>(null);
  const [sendController] = useState(desktopDurableSendController);
  const durableSends = useSyncExternalStore(
    sendController.subscribe,
    sendController.getSnapshot,
    sendController.getSnapshot
  );
  const durableRecoveries = useSyncExternalStore(
    sendController.subscribe,
    sendController.getRecoverySnapshot,
    sendController.getRecoverySnapshot
  );
  const [composerRecovery, setComposerRecovery] = useState<{
    id: string;
    payload: DurableSendPayload;
    durable?: boolean;
  } | null>(null);
  const [threadState, setThreadState] = useState<{
    rootId: string;
    open: boolean;
  } | null>(null);
  const threadCloseTimer = useRef<number | null>(null);
  const knownMessageIds = useRef<Set<string> | null>(null);
  const knownMessageChannelId = useRef(channel.id);
  const knownMessageHistoryMode = useRef(historyMode);
  const knownLatestMessageId = useRef<string | null>(null);
  const enteringMessageIds = useMemo(() => {
    const known = knownMessageChannelId.current === channel.id ? knownMessageIds.current : null;
    const latestMessageId = messages.at(-1)?.id ?? null;
    if (
      !known ||
      historyMode !== "latest" ||
      knownMessageHistoryMode.current !== "latest" ||
      knownLatestMessageId.current === latestMessageId
    ) {
      return new Set<string>();
    }
    return new Set(
      messages.filter((message) => !known.has(message.id)).map((message) => message.id)
    );
  }, [channel.id, historyMode, messages]);
  useEffect(() => {
    knownMessageChannelId.current = channel.id;
    knownMessageHistoryMode.current = historyMode;
    knownLatestMessageId.current = messages.at(-1)?.id ?? null;
    knownMessageIds.current = new Set(messages.map((message) => message.id));
  }, [channel.id, historyMode, messages]);
  useEffect(() => {
    const authoritativeIds = new Set(messages.map((message) => message.id));
    void sendController.reconcile(authoritativeIds);
  }, [messages, sendController]);
  const channelSends = useMemo(
    () => durableSends.filter((record) => record.target.channelId === channel.id),
    [channel.id, durableSends]
  );
  const channelRecoveries = useMemo(
    () => durableRecoveries.filter((record) => record.target.channelId === channel.id),
    [channel.id, durableRecoveries]
  );
  const visibleMessages = useMemo(() => {
    const optimisticServerIds = new Set(
      channelSends.flatMap(({ acceptedMessage }) => (acceptedMessage ? [acceptedMessage.id] : []))
    );
    const authoritativeById = new Map(messages.map((message) => [message.id, message] as const));
    return [
      ...messages
        .filter((message) => !optimisticServerIds.has(message.id))
        .map((message) => ({
          renderKey: messageRenderKey(message),
          message,
          pending: false,
          animateEntrance: enteringMessageIds.has(message.id),
          delivery: null,
        })),
      ...channelSends.map((delivery) => ({
        renderKey: durableSendRenderKey(delivery),
        message:
          (delivery.acceptedMessage
            ? authoritativeById.get(delivery.acceptedMessage.id)
            : undefined) ?? durableSendMessage(delivery),
        pending: durableSendIsInFlight(delivery),
        animateEntrance: true,
        delivery,
      })),
    ].sort(
      (left, right) =>
        new Date(left.message.createdAt).getTime() - new Date(right.message.createdAt).getTime() ||
        left.renderKey.localeCompare(right.renderKey)
    );
  }, [channelSends, enteringMessageIds, messages]);
  const messagesById = useMemo(
    () => new Map(visibleMessages.map(({ message }) => [message.id, message] as const)),
    [visibleMessages]
  );
  useEffect(() => {
    if (composerRecovery) return;
    const recovery = channelRecoveries.find((record) => record.payload.isFork !== true);
    if (!recovery) return;
    if (recovery.payload.replyToMessageId && messagesById.has(recovery.payload.replyToMessageId)) {
      setReplyTarget({ channelId: channel.id, messageId: recovery.payload.replyToMessageId });
    }
    setComposerRecovery({ id: recovery.nonce, payload: recovery.payload, durable: true });
  }, [channel.id, channelRecoveries, composerRecovery, messagesById]);
  const messagesByAddress = useMemo(
    () =>
      new Map(
        visibleMessages.map(({ message }) => [channelMessageAddress(message), message] as const)
      ),
    [visibleMessages]
  );
  const threads = useMemo(
    () => deriveThreads(visibleMessages.map(({ message }) => message)),
    [visibleMessages]
  );
  const focusedThreadRootId = useMemo(() => {
    if (!focusMessage) return null;
    const target = messagesById.get(focusMessage.messageId);
    if (!target || !isBranchedMessage(target)) return null;
    for (const [rootId, thread] of threads) {
      if (thread.replies.some((reply) => reply.id === target.id)) return rootId;
    }
    return null;
  }, [focusMessage, messagesById, threads]);
  useEffect(() => {
    if (!focusedThreadRootId) return;
    if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    setThreadState({ rootId: focusedThreadRootId, open: true });
  }, [focusMessage?.nonce, focusedThreadRootId]);
  const mainMessageRecords = useMemo(
    () =>
      visibleMessages.filter(({ message }) => {
        if (isBranchedMessage(message)) {
          return message.id === focusMessage?.messageId && !focusedThreadRootId;
        }
        return !threadContextMessageIds?.has(message.id) || threads.has(message.id);
      }),
    [
      focusMessage?.messageId,
      focusedThreadRootId,
      threadContextMessageIds,
      threads,
      visibleMessages,
    ]
  );
  const mainMessages = useMemo(
    () => mainMessageRecords.map(({ message }) => message),
    [mainMessageRecords]
  );
  const visibleContextMessageIds = useMemo(() => {
    const ids = new Set(searchContextMessageIds ?? []);
    for (const message of mainMessages) {
      if (threadContextMessageIds?.has(message.id)) ids.add(message.id);
    }
    return ids;
  }, [mainMessages, searchContextMessageIds, threadContextMessageIds]);
  const mainMessageIndexById = useMemo(
    () => new Map(mainMessages.map((message, index) => [message.id, index] as const)),
    [mainMessages]
  );
  const approvals = useMemo(
    () => conversationApprovals(runs, subagents, approvalsByRun),
    [approvalsByRun, runs, subagents]
  );
  const hasPendingApproval = approvals.some((approval) => approval.status === "pending");
  const pendingLocalApproval = useMemo(
    () =>
      approvals
        .filter(isPendingLocalApproval)
        .sort(
          (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        )
        .at(-1) ?? null,
    [approvals]
  );
  const timeline = useMemo(() => {
    const ordered: MessageTimelineEntry[] = mainMessageRecords
      .map(
        ({ animateEntrance, delivery, message, pending, renderKey }): MessageTimelineEntry => ({
          type: "message" as const,
          id: renderKey,
          createdAt: message.createdAt,
          message,
          animateEntrance,
          pending,
          delivery,
        })
      )
      .sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
          left.id.localeCompare(right.id)
      );
    const collapsed =
      channel.kind === "bot_dm" ? collapseA2ATimeline(ordered, (entry) => entry.message) : ordered;
    const messageTimeline = addContextGaps(collapsed, (entry) =>
      entry.type === "message"
        ? visibleContextMessageIds.has(entry.message.id)
        : entry.entries.some((candidate) => visibleContextMessageIds.has(candidate.message.id))
    );
    return [
      ...messageTimeline,
      ...approvals.map((approval) => ({
        type: "approval" as const,
        id: approval.id,
        createdAt: approval.createdAt,
        approval,
      })),
    ].sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id)
    );
  }, [approvals, channel.kind, mainMessageRecords, visibleContextMessageIds]);
  const replyingTo =
    replyTarget?.channelId === channel.id
      ? (messagesById.get(replyTarget.messageId) ?? null)
      : null;
  const replyToMessage = useCallback(
    (message: ChannelMessageView) => {
      setReplyTarget({ channelId: channel.id, messageId: message.id });
    },
    [channel.id]
  );
  const openThread = useCallback((message: ChannelMessageView) => {
    if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    setThreadState({ rootId: message.id, open: true });
  }, []);
  const closeThread = useCallback(() => {
    setThreadState((current) => (current ? { ...current, open: false } : null));
    if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    threadCloseTimer.current = window.setTimeout(() => setThreadState(null), 300);
  }, []);
  useEffect(
    () => () => {
      if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    },
    []
  );
  const reactToMessage = useCallback(
    (message: ChannelMessageView, emoji: string) => {
      if (!onReactMessage) return;
      void onReactMessage(message.id, emoji).catch(() => undefined);
    },
    [onReactMessage]
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    const bots =
      channel.kind === "group"
        ? channel.members.flatMap((member) => {
            const bot = botById.get(member.botId);
            return bot ? [bot] : [];
          })
        : [...botById.values()].filter(
            (bot) => bot.status === "active" && bot.id !== selectedBot?.id
          );
    return [
      ...(channel.kind === "group" && channel.members.length >= 2
        ? [
            {
              id: "__everyone__",
              label: "everyone",
              handle: "everyone",
            },
          ]
        : []),
      ...bots.map((bot) => ({
        id: bot.id,
        label: bot.name,
        handle: mentionHandleFor(bot.name),
        color: bot.color,
        icon: bot.icon,
        hasAvatar: bot.hasAvatar,
        updatedAt: bot.updatedAt,
      })),
    ];
  }, [botById, channel.kind, channel.members, selectedBot?.id]);
  const enqueueDurableSend = useCallback(
    (
      content: string,
      attachments: AssetRef[],
      replyToMessageId?: string,
      options?: {
        richText?: string;
        isFork?: boolean;
        stagedAttachments?: DurableSendPayload["stagedAttachments"];
      }
    ) =>
      sendController.enqueue({
        target: {
          channelId: channel.id,
          conversationId:
            channel.kind === "bot_dm" && selectedBot ? selectedBot.conversationId : null,
        },
        payload: {
          content,
          attachments,
          ...(options?.stagedAttachments?.length
            ? { stagedAttachments: options.stagedAttachments }
            : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(options?.richText ? { richText: options.richText } : {}),
          ...(options?.isFork !== undefined ? { isFork: options.isFork } : {}),
        },
      }),
    [channel.id, channel.kind, selectedBot, sendController]
  );
  const submit = useCallback(
    (
      content: string,
      attachments: AssetRef[],
      options?: {
        richText?: string;
        stagedAttachments?: DurableSendPayload["stagedAttachments"];
      }
    ) => enqueueDurableSend(content, attachments, replyingTo?.id, options),
    [enqueueDurableSend, replyingTo?.id]
  );
  const resendDurableSend = useCallback(
    async (nonce: string) => {
      await sendController.resendFailed(nonce);
    },
    [sendController]
  );
  const deleteDurableSend = useCallback(
    async (nonce: string) => {
      await sendController.deleteFailed(nonce);
    },
    [sendController]
  );
  const cancelDurableSend = useCallback(
    async (nonce: string) => {
      const payload = await sendController.cancelQueued(nonce);
      if (!payload) return;
      if (payload.replyToMessageId && messagesById.has(payload.replyToMessageId)) {
        setReplyTarget({ channelId: channel.id, messageId: payload.replyToMessageId });
      }
      setComposerRecovery({ id: `${nonce}:${Date.now()}`, payload });
    },
    [channel.id, messagesById, sendController]
  );
  const botCanQueue = selectedBot && ["provisioning", "active"].includes(selectedBot.status);
  const onboardingInProgress = Boolean(
    selectedBot && ["pending", "queued", "running"].includes(selectedBot.onboardingStatus)
  );
  const canSend =
    channel.kind !== "agent_dm" &&
    (channel.kind === "bot_dm" ? Boolean(botCanQueue) : runtime.agent === "ready");
  const showThinkingIndicator = Boolean(
    activeRun && !hasPendingApproval && !(visibleMessages.length === 0 && onboardingInProgress)
  );
  const thinkingPhase = useThinkingPresence(showThinkingIndicator);
  const thinkingMounted = thinkingPhase !== "hidden";
  const renderedTimeline = useMemo(() => {
    const transcriptTimeline = timeline.filter(
      (entry) => entry.type !== "approval" || !isPendingLocalApproval(entry.approval)
    );
    if (thinkingPhase === "hidden") return transcriptTimeline;
    return [
      ...transcriptTimeline,
      {
        type: "thinking" as const,
        id: "thinking-slot",
        createdAt:
          activeRun?.createdAt ?? transcriptTimeline.at(-1)?.createdAt ?? channel.createdAt,
        phase: thinkingPhase,
        bot: activeRun ? botById.get(activeRun.botId) : selectedBot,
      },
    ];
  }, [activeRun, botById, channel.createdAt, selectedBot, thinkingPhase, timeline]);
  const focusedRenderedTimelineEntry = useMemo(() => {
    if (!focusMessage || !messagesById.has(focusMessage.messageId)) return null;
    const index = renderedTimeline.findIndex(
      (entry) => entry.type === "message" && entry.message.id === focusMessage.messageId
    );
    return index < 0
      ? null
      : { index, messageId: focusMessage.messageId, nonce: focusMessage.nonce };
  }, [focusMessage, messagesById, renderedTimeline]);
  const resolveApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision) =>
      mutate(() => api.resolveApproval(approvalId, decision)).then((value) => {
        const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const result =
          body.result && typeof body.result === "object"
            ? (body.result as Record<string, unknown>)
            : {};
        if (typeof result.authorizationUrl === "string") {
          window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        }
      }),
    [mutate]
  );
  return (
    <div
      className="relative flex size-full min-h-0 flex-col bg-background"
      data-chat-drop-target=""
      ref={fileDropTargetRef}
    >
      {active && (
        <Conversation>
          <ConversationTopDivider />
          <ConversationContent
            className="max-w-none gap-1 px-4 pt-10"
            style={{ paddingBottom: 24 }}
          >
            {activityTruncated && (
              <div
                className="mx-auto mb-2 w-full max-w-[640px] rounded-lg border border-border bg-muted/45 px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                Older run details are summarized; active runs and pending approvals remain visible.
              </div>
            )}
            {threadContextTruncated && (
              <div
                className="mx-auto mb-2 w-full max-w-[640px] rounded-lg border border-border bg-muted/45 px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                Some older thread context is omitted. Open or search an older reply to load its
                local thread window.
              </div>
            )}
            {timeline.length === 0 && onboardingInProgress ? (
              <>
                <div className="flex justify-center pb-3 pt-[26.5px]">
                  <time
                    className="select-none text-xs tabular-nums text-muted-foreground"
                    dateTime={channel.createdAt}
                  >
                    {formatIdleGapTimestamp(channel.createdAt, now)}
                  </time>
                </div>
                <BotThinkingSlot bot={selectedBot} phase="visible" />
              </>
            ) : timeline.length === 0 ? (
              <ConversationEmptyState
                description={
                  channel.kind === "group"
                    ? "One room, delivered to each bot in order."
                    : "Messages wake the same durable Pi session."
                }
                icon={
                  channel.kind === "group" ? (
                    <Users className="size-8" />
                  ) : (
                    <MessageCircle className="size-8" />
                  )
                }
                title={channel.kind === "group" ? "Start the group" : "Start a conversation"}
              />
            ) : (
              <VirtualizedTimeline
                conversationId={channel.id}
                entries={renderedTimeline}
                focus={focusedRenderedTimelineEntry}
                hasOlder={hasOlder}
                hasNewer={hasNewer}
                loadingOlder={loadingOlder}
                loadingNewer={loadingNewer}
                onLoadOlder={onLoadOlder}
                onLoadNewer={onLoadNewer}
                renderEntry={(entry, index) =>
                  entry.type === "context_gap" ? (
                    <div
                      aria-label="Messages between this search context and the latest view are omitted"
                      className="mx-auto my-2 flex w-full max-w-[640px] items-center gap-3 px-4 text-[11px] text-muted-foreground"
                      role="separator"
                    >
                      <span className="h-px flex-1 bg-border" />
                      <span>
                        Messages between this search context and the latest view are omitted
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  ) : (
                    <Fragment>
                      {entry.type !== "thinking" &&
                        shouldShowIdleGapTimestamp(
                          renderedTimeline[index - 1]?.createdAt,
                          entry.createdAt
                        ) && (
                          <div
                            className={`flex justify-center pb-3 ${index === 0 ? "pt-[26.5px]" : "pt-6"}`}
                          >
                            <time
                              className="select-none text-xs tabular-nums text-muted-foreground"
                              dateTime={entry.createdAt}
                            >
                              {formatIdleGapTimestamp(entry.createdAt, now)}
                            </time>
                          </div>
                        )}
                      {entry.type === "thinking" ? (
                        <BotThinkingSlot bot={entry.bot} phase={entry.phase} />
                      ) : entry.type === "a2a" ? (
                        <A2AActivityRow
                          count={entry.entries.length}
                          onOpen={
                            entry.peerId && onOpenA2A && selectedBot
                              ? (trigger) =>
                                  onOpenA2A(selectedBot.id, entry.peerId as string, trigger)
                              : undefined
                          }
                          peer={entry.peerId ? botById.get(entry.peerId) : undefined}
                          peerName={entry.peerName ?? "another agent"}
                        />
                      ) : entry.type === "approval" ? (
                        <div
                          className={
                            isResolvedLocalApproval(entry.approval)
                              ? "mt-2 w-full min-w-0"
                              : "mr-auto mt-2 w-full min-w-0 max-w-[min(88%,520px,calc(100%-82px))]"
                          }
                        >
                          <ApprovalCard
                            approval={entry.approval}
                            onResolve={(decision) => resolveApproval(entry.approval.id, decision)}
                          />
                        </div>
                      ) : (
                        <MessageRow
                          animateEntrance={entry.animateEntrance}
                          canInteract={
                            canSend &&
                            !entry.pending &&
                            entry.delivery?.phase !== "failed" &&
                            entry.message.sender !== "system"
                          }
                          channel={channel}
                          groupPosition={appendThinkingIndicatorToGroup(
                            getMessageGroupPosition(
                              mainMessages,
                              mainMessageIndexById.get(entry.message.id) ?? -1
                            ),
                            (() => {
                              const following = renderedTimeline[index + 1];
                              return Boolean(
                                thinkingMounted &&
                                  following?.type === "thinking" &&
                                  entry.message.sender === "agent" &&
                                  (!entry.message.senderBotId ||
                                    !following.bot?.id ||
                                    entry.message.senderBotId === following.bot.id)
                              );
                            })()
                          )}
                          message={entry.message}
                          delivery={entry.delivery}
                          pending={entry.pending}
                          onCancelSend={cancelDurableSend}
                          onDeleteSend={deleteDurableSend}
                          onReact={reactToMessage}
                          onReply={replyToMessage}
                          onResendSend={resendDurableSend}
                          onOpenThread={openThread}
                          onOpenRoutine={onOpenRoutine}
                          replyPreview={(() => {
                            const preview = replyTargetFor(
                              entry.message,
                              messagesById,
                              messagesByAddress
                            );
                            if (!preview) return null;
                            return {
                              content:
                                preview.content ||
                                (messageImages(preview).length > 0 ? "Image" : ""),
                              senderLabel: messageSenderLabel(preview, botById),
                            };
                          })()}
                          separatedFromPrevious={(() => {
                            const previous = renderedTimeline[index - 1];
                            return Boolean(
                              previous &&
                                (previous.type !== "message" ||
                                  !messagesShareGroup(previous.message, entry.message)) &&
                                !shouldShowIdleGapTimestamp(
                                  previous.createdAt,
                                  entry.message.createdAt
                                )
                            );
                          })()}
                          senderBot={
                            entry.message.senderBotId
                              ? botById.get(entry.message.senderBotId)
                              : undefined
                          }
                          senderName={
                            entry.message.senderBotId
                              ? agentNameById.get(entry.message.senderBotId)
                              : undefined
                          }
                          threadReplyCount={threads.get(entry.message.id)?.replies.length ?? 0}
                        />
                      )}
                    </Fragment>
                  )
                }
              />
            )}
            {templateShareRequest && selectedBot && (
              <Suspense fallback={null}>
                <BotTemplateConversationFlow
                  bot={selectedBot}
                  onSubmitPrompt={(content) => enqueueDurableSend(content, [])}
                  request={templateShareRequest}
                />
              </Suspense>
            )}
          </ConversationContent>
          <ConversationViewportAnchor
            active={composerExpanded || pendingAttachmentCount > 0 || Boolean(pendingLocalApproval)}
          />
          <ConversationScrollButton
            conversationId={channel.id}
            forceLatest={historyMode !== "latest" || hasNewerGap}
            latestEntryKey={
              renderedTimeline.length > 0
                ? `${renderedTimeline[renderedTimeline.length - 1]?.type}:${renderedTimeline[renderedTimeline.length - 1]?.id}`
                : null
            }
            messageCount={renderedTimeline.length}
            onAtBottomChange={onViewportAtBottomChange}
            onScrollToNewest={onScrollToNewest}
            trackNewMessages={historyMode === "latest"}
          />
        </Conversation>
      )}
      {channel.kind === "agent_dm" ? (
        <div className="a2a-exchange-footer mx-auto w-full max-w-[1040px] px-5 pb-4">
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            <span>This chat is view-only</span>
            {onCloseViewOnly && (
              <Button
                className="h-7 rounded-full px-3 text-xs"
                onClick={onCloseViewOnly}
                variant="secondary"
              >
                Close Chat
              </Button>
            )}
          </div>
        </div>
      ) : onboardingInProgress ? null : (
        <div className="relative z-[3] w-full shrink-0" data-composer-dock="">
          {pendingLocalApproval ? (
            <div
              className="pointer-events-auto relative z-[3] w-full min-w-0 px-4 pb-2"
              data-local-tool-permission-dock=""
            >
              <ApprovalCard
                approval={pendingLocalApproval}
                onResolve={(decision) => resolveApproval(pendingLocalApproval.id, decision)}
              />
            </div>
          ) : (
            <PromptInput
              uploadCapabilities={capabilities.uploads}
              disabled={!canSend}
              docked
              dropTargetRef={fileDropTargetRef}
              key={channel.id}
              recovery={composerRecovery}
              onAttachmentsChange={setPendingAttachmentCount}
              onCancelReply={() => setReplyTarget(null)}
              onExpandedChange={setComposerExpanded}
              onRecoveryApplied={() =>
                setComposerRecovery((current) => (current?.durable ? current : null))
              }
              onRecoveryConsumed={async (nonce) => {
                await sendController.acknowledgeRecovery(nonce);
                setComposerRecovery((current) => (current?.id === nonce ? null : current));
              }}
              onSubmit={submit}
              onStage={stageDesktopDeliveryFile}
              onDiscardStages={discardDesktopDeliveryStages}
              mentionOptions={mentionOptions}
              placeholder={
                selectedBot?.status === "provisioning"
                  ? `Message ${channel.name} — it will be queued`
                  : runtime.agent !== "ready"
                    ? channel.kind === "bot_dm"
                      ? `Message ${channel.name} — it will be queued`
                      : "Pi runtime is not ready"
                    : `Message ${channel.name}`
              }
              reply={
                replyingTo
                  ? {
                      id: replyingTo.id,
                      content:
                        replyingTo.content || (messageImages(replyingTo).length > 0 ? "Image" : ""),
                    }
                  : null
              }
            />
          )}
        </div>
      )}
      {threadState && messagesById.get(threadState.rootId) && (
        <ThreadTray
          botById={botById}
          deliveries={channelSends}
          recoveries={channelRecoveries}
          focusMessageId={focusedThreadRootId && focusMessage ? focusMessage.messageId : null}
          mentionOptions={mentionOptions}
          onClose={closeThread}
          onCancelSend={(nonce) => sendController.cancelQueued(nonce)}
          onDeleteSend={(nonce) => sendController.deleteFailed(nonce)}
          onResendSend={(nonce) => sendController.resendFailed(nonce)}
          onAcknowledgeRecovery={(nonce) => sendController.acknowledgeRecovery(nonce)}
          onSubmit={(content, attachments, options) => {
            const thread = threads.get(threadState.rootId);
            const replyTargetId = thread?.replies.at(-1)?.id ?? threadState.rootId;
            return enqueueDurableSend(content, attachments, replyTargetId, {
              ...options,
              isFork: true,
            });
          }}
          onStage={stageDesktopDeliveryFile}
          onDiscardStages={discardDesktopDeliveryStages}
          open={threadState.open}
          replies={threads.get(threadState.rootId)?.replies ?? []}
          root={messagesById.get(threadState.rootId) as ChannelMessageView}
        />
      )}
    </div>
  );
}, chatPanePropsEqual);
