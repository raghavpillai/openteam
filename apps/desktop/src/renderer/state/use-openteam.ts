import { isWindowVisible, WINDOW_VISIBILITY_EVENT } from "../lib/window-visibility";
import { createKeyedRequestCoordinator } from "@openteam/client-core";
import type { ChannelMessageView, ClientSnapshot } from "@openteam/contracts";
import { CLIENT_CAPABILITIES, type ClientCapabilities } from "@openteam/contracts/capabilities";
import {
  compareEntitySequence as compareSequence,
  type LoadedChannelHistory,
  loadingChannelHistory,
} from "@openteam/product-core/history";
import { toggleOwnReaction } from "@openteam/product-core/messages";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDesktopLiveSyncController, shouldRefreshForEvent } from "../client/event-stream";
import { api, type ChannelClientState, type ClientBootstrapView } from "../client/openteam-api";
import {
  DURABLE_SEND_ACCEPTED_EVENT,
  setDesktopSendLiveTransportHealthy,
} from "../lib/durable-sends";
import { nextHistoryPageLoadStartedAt } from "../lib/history-pagination";
import {
  applyPrimaryHistoryPage,
  type ChannelMessageWindowState,
  clearMessageContext,
  emptyChannelMessageWindow,
  enterMessageContext,
  expandMessageContext,
  MESSAGE_HISTORY_PAGE_SIZE,
  type MessageHistoryDirection,
  type MessageViewportRetention,
  patchRetainedMessageWindow,
  resetToLatestTail,
  retainedMessageWindowStats,
  setContextLoading,
} from "../lib/message-history-window";
import { recordPerformance } from "../lib/performance";
import { createSnapshotCaches, reconcileClientSnapshot } from "../lib/snapshot-reconcile";
import {
  backgroundHistoryNeed as backgroundHistoryNeedFor,
  bootstrapSnapshot,
  openHistoryNeedsRead,
} from "../lib/bootstrap-snapshot";
import { withDeadline } from "../lib/request-errors";
import { RUNTIME_REFRESH_EVENT } from "../lib/runtime-refresh";

export type OpenTeamMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface ChannelHistoryStatus {
  initialLoading: boolean;
  generation: number;
  mode: "latest" | "history" | "context";
  hasOlder: boolean;
  hasNewer: boolean;
  hasNewerGap: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  loadedMessages: number;
  retainedBytes: number;
  activityTruncated: boolean;
  threadContextTruncated: boolean;
}

// Revisiting one of these chats reuses its loaded transcript instead of showing
// a loading state. Each history window is capped by MESSAGE_HISTORY_MAX_RETAINED_BYTES.
const MAX_WARM_HISTORIES = 8;
// Background reads of a chat that is not open only need to reach the messages
// it already holds; a longer gap replaces the page as an opened chat would.
const BACKGROUND_REFRESH_PAGE_SIZE = 25;
// Unread chats the user has not opened yet, newest reply first, kept ready to open.
const MAX_BACKGROUND_LOADS = 3;
const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();
// The live stream keeps a focused window current. A focus refresh only catches
// up after a long quiet period, e.g. waking from sleep with a silent stream.
const FOCUS_REFRESH_AFTER_MS = 15_000;

const sameCapabilities = (left: ClientCapabilities, right: ClientCapabilities) =>
  left.uploads.maxAttachmentsPerMessage === right.uploads.maxAttachmentsPerMessage &&
  left.uploads.maxRegularBytes === right.uploads.maxRegularBytes &&
  left.uploads.maxVideoBytes === right.uploads.maxVideoBytes;

const sameStringSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
};

export function useOpenTeam() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const snapshotRef = useRef<ClientSnapshot | null>(null);
  const [detachedMessageIds, setDetachedMessageIds] =
    useState<ReadonlySet<string>>(EMPTY_MESSAGE_IDS);
  const detachedMessageIdsRef = useRef<ReadonlySet<string>>(EMPTY_MESSAGE_IDS);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [capabilities, setCapabilities] = useState<ClientCapabilities>(CLIENT_CAPABILITIES);
  const [historyRevision, setHistoryRevision] = useState(0);
  const cursor = useRef("0");
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshRequested = useRef(false);
  const refreshNeedsForeground = useRef(false);
  const refreshError = useRef<unknown>(null);
  const initialRefreshStarted = useRef(false);
  const bootstrapRef = useRef<ClientBootstrapView | null>(null);
  const bootstrapEpoch = useRef(0);
  const histories = useRef(new Map<string, LoadedChannelHistory>());
  const historyWindows = useRef(new Map<string, ChannelMessageWindowState>());
  const channelStates = useRef(new Map<string, ChannelClientState>());
  const channelLoads = useRef(new Map<string, { task: Promise<void>; background: boolean }>());
  const historyRequests = useRef(createKeyedRequestCoordinator());
  const historyLoadStartedAt = useRef(new Map<string, number>());
  const contextNewerLoadStartedAt = useRef(new Map<string, number>());
  const historyViewportAtBottom = useRef(new Map<string, boolean>());
  const historyViewports = useRef(new Map<string, MessageViewportRetention>());
  const searchContextRequests = useRef(createKeyedRequestCoordinator());
  const historyLru = useRef<string[]>([]);
  // Cached chats that were only read in the background and never opened.
  const backgroundLoaded = useRef(new Set<string>());
  const threadContextIdsCache = useRef(new Map<string, ReadonlySet<string>>());
  const searchContextIdsCache = useRef(new Map<string, ReadonlySet<string>>());
  const caches = useRef(createSnapshotCaches());
  const lastRuntimePoll = useRef(0);
  const lastRefreshCompletedAt = useRef(0);

  const publish = useCallback(
    (
      incoming: ClientSnapshot,
      quiet: boolean,
      detached: ReadonlySet<string> = EMPTY_MESSAGE_IDS
    ) => {
      const startedAt = performance.now();
      const next = reconcileClientSnapshot(incoming, snapshotRef.current, caches.current);
      const changed = next !== snapshotRef.current;
      const nextDetached =
        detached.size === 0
          ? EMPTY_MESSAGE_IDS
          : sameStringSet(detached, detachedMessageIdsRef.current)
            ? detachedMessageIdsRef.current
            : detached;
      // Commit the transcript exclusions with the snapshot they describe.
      const commit = () => {
        snapshotRef.current = next;
        detachedMessageIdsRef.current = nextDetached;
        setSnapshot((current) => (current === next ? current : next));
        setDetachedMessageIds(nextDetached);
      };
      if (quiet) startTransition(commit);
      else commit();
      recordPerformance("snapshot.reconcile", performance.now() - startedAt, {
        changed,
        messages: next.channelMessages.length,
      });
    },
    []
  );

  const publishBootstrap = useCallback(
    (quiet: boolean) => {
      const bootstrap = bootstrapRef.current;
      if (!bootstrap) return;
      const nextCapabilities = bootstrap.capabilities ?? CLIENT_CAPABILITIES;
      setCapabilities((current) =>
        sameCapabilities(current, nextCapabilities) ? current : nextCapabilities
      );
      const { snapshot: next, detachedMessageIds: detached } = bootstrapSnapshot(
        bootstrap,
        histories.current,
        historyWindows.current,
        channelStates.current
      );
      publish(next, quiet, detached);
    },
    [publish]
  );

  const invalidateHistory = useCallback((channelId: string) => {
    backgroundLoaded.current.delete(channelId);
    historyRequests.current.invalidate(channelId);
    searchContextRequests.current.invalidate(channelId);
    histories.current.delete(channelId);
    historyWindows.current.delete(channelId);
    channelStates.current.delete(channelId);
    historyLoadStartedAt.current.delete(channelId);
    contextNewerLoadStartedAt.current.delete(channelId);
    historyViewportAtBottom.current.delete(channelId);
    historyViewports.current.delete(channelId);
    // The request cannot be cancelled here, but removing it lets a later
    // selection start a current request. Its epoch guard prevents the old
    // promise from repopulating an evicted cache.
    channelLoads.current.delete(channelId);
  }, []);

  const touchHistory = useCallback(
    (channelId: string) => {
      backgroundLoaded.current.delete(channelId);
      historyLru.current = [
        channelId,
        ...historyLru.current.filter((candidate) => candidate !== channelId),
      ];
      let evictedHistory = false;
      while (historyLru.current.length > MAX_WARM_HISTORIES) {
        const evicted = historyLru.current.pop();
        if (!evicted) break;
        invalidateHistory(evicted);
        evictedHistory = true;
      }
      if (evictedHistory) setHistoryRevision((value) => value + 1);
    },
    [invalidateHistory]
  );

  const setHistoryViewport = useCallback(
    (channelId: string, messageIds: readonly string[], fill: MessageViewportRetention["fill"]) => {
      const nextIds = new Set(messageIds);
      const previous = historyViewports.current.get(channelId);
      if (previous?.fill === fill && sameStringSet(previous.messageIds, nextIds)) return;
      historyViewports.current.set(channelId, { fill, messageIds: nextIds });
    },
    []
  );

  // A quiet snapshot publish is a transition. History status must commit with
  // it, or a pane briefly sees "loaded" alongside the previous snapshot.
  const bumpHistoryRevision = useCallback((quiet: boolean) => {
    if (quiet) startTransition(() => setHistoryRevision((value) => value + 1));
    else setHistoryRevision((value) => value + 1);
  }, []);

  const fetchChannel = useCallback(
    async (channelId: string, replaceHistory: boolean, quiet: boolean, background = false) => {
      let existingLoad = channelLoads.current.get(channelId);
      if (existingLoad?.background && !background) {
        // An opened chat also needs its run state. Let the background page land first.
        await existingLoad.task.catch(() => undefined);
        existingLoad = channelLoads.current.get(channelId);
      }
      if (existingLoad) return existingLoad.task;
      const requestLease = historyRequests.current.supersede(channelId);
      const existing = histories.current.get(channelId);
      const pageSize =
        background && existing && existing.loadedAt > 0
          ? BACKGROUND_REFRESH_PAGE_SIZE
          : MESSAGE_HISTORY_PAGE_SIZE;
      histories.current.set(channelId, loadingChannelHistory(existing));
      setHistoryRevision((value) => value + 1);
      let task!: Promise<void>;
      task = (async () => {
        try {
          let state!: Awaited<ReturnType<typeof api.channelState>>;
          let stateIsCurrent = true;
          const stillRequested = () =>
            historyRequests.current.isCurrent(requestLease) &&
            historyLru.current.includes(channelId);
          // History/state revisions are the global event high-water mark
          // observed by those reads. A request that straddled bootstrap is
          // still safe when the read observed its cursor.
          const observedBootstrap = (revision: string, requestBootstrapEpoch: number) => {
            const bootstrapCursor = bootstrapRef.current?.cursor;
            return (
              requestBootstrapEpoch === bootstrapEpoch.current ||
              !bootstrapCursor ||
              compareSequence({ sequence: revision }, { sequence: bootstrapCursor }) >= 0
            );
          };
          const applyLatestPage = (page: Awaited<ReturnType<typeof api.channelHistory>>) => {
            const current = histories.current.get(channelId);
            const shouldReplace = replaceHistory || !current || current.loadedAt === 0;
            const mergeStartedAt = performance.now();
            const transition = applyPrimaryHistoryPage({
              current,
              window: historyWindows.current.get(channelId),
              page,
              mode: shouldReplace ? "replace" : "refresh",
              atBottom: historyViewportAtBottom.current.get(channelId) ?? true,
              viewport: historyViewports.current.get(channelId),
            });
            histories.current.set(channelId, transition.history);
            historyWindows.current.set(channelId, transition.window);
            const retained = retainedMessageWindowStats(transition.history, transition.window);
            const viewport = historyViewports.current.get(channelId);
            recordPerformance("history.page.merge", performance.now() - mergeStartedAt, {
              direction: "latest",
              mode: shouldReplace ? "replace" : "refresh",
              outcome: transition.outcome,
              messages: transition.history.messages.length,
              retainedBytes: transition.window.retainedBytes,
              retainedMessages: retained.messages,
              viewportFill: viewport?.fill ?? "none",
              viewportProtected: viewport?.messageIds.size ?? 0,
              evictedOlder: transition.evictedOlder,
              evictedNewer: transition.evictedNewer,
            });
            bumpHistoryRevision(quiet);
            publishBootstrap(quiet);
          };
          // A saved channel can begin hydrating before bootstrap. If bootstrap
          // advances while that request is in flight, retry once against the
          // now-known cursor instead of letting its older state win the merge.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const requestBootstrapEpoch = bootstrapEpoch.current;
            // Run state is only shown in an open chat, and can be far larger.
            const stateRequest = background ? null : api.channelState(channelId);
            // The history read may fail first; still observe this rejection.
            stateRequest?.catch(() => undefined);
            const page = await api.channelHistory(channelId, { limit: pageSize });
            if (!stillRequested()) return;
            const pageIsCurrent = observedBootstrap(page.revision, requestBootstrapEpoch);
            // Show messages as soon as they arrive. Channel state only carries
            // run activity, and can be far larger, so it never delays them.
            if (pageIsCurrent || attempt === 1) applyLatestPage(page);
            if (!stateRequest) {
              if (pageIsCurrent) break;
              continue;
            }
            state = await stateRequest;
            if (!stillRequested()) return;
            stateIsCurrent =
              pageIsCurrent && observedBootstrap(state.revision, requestBootstrapEpoch);
            if (stateIsCurrent || attempt === 1) break;
          }
          if (background) return;
          if (stateIsCurrent) channelStates.current.set(channelId, state);
          else channelStates.current.delete(channelId);
          bumpHistoryRevision(quiet);
          publishBootstrap(quiet);
        } catch (cause) {
          const stillCurrent =
            historyRequests.current.isCurrent(requestLease) &&
            historyLru.current.includes(channelId);
          if (stillCurrent) {
            const current = histories.current.get(channelId);
            if (current) histories.current.set(channelId, { ...current, loading: false });
            setHistoryRevision((value) => value + 1);
            // The next event or opening the chat reads it again.
            if (background) return;
            setError(clientErrorMessage(cause, "Could not load this conversation"));
            throw cause;
          }
        }
      })().finally(() => {
        if (channelLoads.current.get(channelId)?.task === task) {
          channelLoads.current.delete(channelId);
        }
      });
      channelLoads.current.set(channelId, { task, background });
      return task;
    },
    [bumpHistoryRevision, publishBootstrap]
  );

  // Replies keep landing in chats that are not open, usually with a notification.
  // Read the newest page of those chats in the background, one at a time and
  // without run state, so opening one shows the reply instead of waiting for it.
  const backgroundHistoryQueue = useRef(new Set<string>());
  const backgroundHistoryRunning = useRef(false);
  const backgroundHistoryNeed = useCallback((channelId: string) => {
    const bootstrap = bootstrapRef.current;
    if (!bootstrap) return null;
    return backgroundHistoryNeedFor({
      bootstrap,
      channelId,
      activeChannelId: historyLru.current[0],
      history: histories.current.get(channelId),
      detachedMessageIds: detachedMessageIdsRef.current,
    });
  }, []);

  const syncBackgroundHistories = useCallback(async () => {
    const initial = bootstrapRef.current;
    if (!initial) return;
    for (const channel of initial.channels) {
      if (backgroundHistoryNeed(channel.id)) backgroundHistoryQueue.current.add(channel.id);
    }
    if (backgroundHistoryRunning.current) return;
    backgroundHistoryRunning.current = true;
    try {
      while (backgroundHistoryQueue.current.size > 0) {
        const bootstrap = bootstrapRef.current;
        if (!bootstrap) return;
        const latest = (channelId: string) =>
          bootstrap.latestMessages.find((message) => message.channelId === channelId);
        const newestFirst = (left: string, right: string) => {
          const a = latest(left);
          const b = latest(right);
          return a && b ? compareSequence(b, a) : 0;
        };
        // Cached chats first, one small page each; then the newest unread replies.
        const queued = [...backgroundHistoryQueue.current].sort(newestFirst);
        const channelId =
          queued.find((candidate) => backgroundHistoryNeed(candidate) === "refresh") ?? queued[0];
        if (!channelId) break;
        backgroundHistoryQueue.current.delete(channelId);
        const need = backgroundHistoryNeed(channelId);
        if (!need) continue;
        if (need === "load") {
          const lru = historyLru.current;
          // The open chat stays at the front; nothing was opened yet to rank against.
          if (lru.length === 0) continue;
          const loaded = lru.filter((candidate) => backgroundLoaded.current.has(candidate));
          if (loaded.length >= MAX_BACKGROUND_LOADS || lru.length >= MAX_WARM_HISTORIES) {
            // A newer reply replaces the background chat with the oldest one.
            // Chats the user opened are never displaced for a background read.
            const oldest = loaded.sort(newestFirst).at(-1);
            const oldestLatest = oldest ? latest(oldest) : undefined;
            const candidateLatest = latest(channelId);
            if (
              !oldest ||
              !oldestLatest ||
              !candidateLatest ||
              compareSequence(candidateLatest, oldestLatest) <= 0
            )
              continue;
            historyLru.current = historyLru.current.filter((candidate) => candidate !== oldest);
            invalidateHistory(oldest);
            setHistoryRevision((value) => value + 1);
          }
          historyLru.current = [...historyLru.current, channelId];
          backgroundLoaded.current.add(channelId);
        }
        // An opened chat's own load may already be in flight and own its errors.
        await fetchChannel(channelId, false, true, true).catch(() => undefined);
      }
    } finally {
      backgroundHistoryRunning.current = false;
    }
  }, [backgroundHistoryNeed, fetchChannel, invalidateHistory]);

  const loadChannel = useCallback(
    async (channelId: string) => {
      const bootstrap = bootstrapRef.current;
      if (bootstrap && !bootstrap.channels.some((channel) => channel.id === channelId)) return;
      touchHistory(channelId);
      let existing = histories.current.get(channelId);
      const window = historyWindows.current.get(channelId) ?? emptyChannelMessageWindow();
      if (
        existing &&
        (existing.searchContext.length > 0 || existing.searchThreadContext.length > 0)
      ) {
        const transition = clearMessageContext(existing, window);
        existing = transition.history;
        histories.current.set(channelId, transition.history);
        historyWindows.current.set(channelId, transition.window);
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
      }
      await fetchChannel(channelId, !existing || existing.loadedAt === 0, true);
    },
    [fetchChannel, publishBootstrap, touchHistory]
  );

  const loadContextPage = useCallback(
    async (
      channelId: string,
      direction: MessageHistoryDirection,
      viewportMessageIds?: readonly string[]
    ) => {
      const fill = direction === "older" ? ("older-first" as const) : ("newer-first" as const);
      if (viewportMessageIds) setHistoryViewport(channelId, viewportMessageIds, fill);
      const existing = histories.current.get(channelId);
      const window = historyWindows.current.get(channelId);
      const context = window?.context;
      if (!existing || !window || !context || context.loadingDirection) return;
      const hasMore = direction === "older" ? context.hasMoreBefore : context.hasMoreAfter;
      if (!hasMore) return;
      const startedAt = nextHistoryPageLoadStartedAt({
        now: performance.now(),
        lastStartedAt:
          (direction === "older"
            ? historyLoadStartedAt.current
            : contextNewerLoadStartedAt.current
          ).get(channelId) ?? null,
      });
      if (startedAt === null) return;
      const startedAtMap =
        direction === "older" ? historyLoadStartedAt.current : contextNewerLoadStartedAt.current;
      startedAtMap.set(channelId, startedAt);
      const edgeMessage =
        direction === "older" ? existing.searchContext[0] : existing.searchContext.at(-1);
      if (!edgeMessage) return;
      const requestLease = searchContextRequests.current.supersede(channelId);
      const requestedGeneration = window.generation;
      const requestedEdgeId = edgeMessage.id;
      historyWindows.current.set(channelId, setContextLoading(window, direction));
      setHistoryRevision((value) => value + 1);
      const requestStartedAt = performance.now();
      try {
        const page = await api.messageContext(requestedEdgeId, {
          direction: direction === "older" ? "before" : "after",
          limit: MESSAGE_HISTORY_PAGE_SIZE,
        });
        if (
          !searchContextRequests.current.isCurrent(requestLease) ||
          !historyLru.current.includes(channelId)
        ) {
          recordPerformance("history.page.stale-discard", performance.now() - requestStartedAt, {
            direction,
            reason: "request",
          });
          return;
        }
        const current = histories.current.get(channelId);
        const currentWindow = historyWindows.current.get(channelId);
        const currentEdge =
          direction === "older" ? current?.searchContext[0] : current?.searchContext.at(-1);
        if (
          !current ||
          !currentWindow?.context ||
          currentWindow.generation !== requestedGeneration ||
          currentEdge?.id !== requestedEdgeId ||
          page.channelId !== channelId
        ) {
          recordPerformance("history.page.stale-discard", performance.now() - requestStartedAt, {
            direction,
            reason: "generation",
          });
          return;
        }
        const mergeStartedAt = performance.now();
        const currentViewport = historyViewports.current.get(channelId);
        const transition = expandMessageContext({
          current,
          window: currentWindow,
          page,
          direction,
          viewport: currentViewport ? { ...currentViewport, fill } : undefined,
        });
        histories.current.set(channelId, transition.history);
        historyWindows.current.set(channelId, transition.window);
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
        const retained = retainedMessageWindowStats(transition.history, transition.window);
        recordPerformance("history.page.merge", performance.now() - mergeStartedAt, {
          direction,
          mode: "context",
          messages: transition.history.searchContext.length,
          retainedBytes: transition.window.retainedBytes,
          retainedMessages: retained.messages,
          viewportFill: fill,
          viewportProtected: currentViewport?.messageIds.size ?? 0,
          evictedOlder: transition.evictedOlder,
          evictedNewer: transition.evictedNewer,
        });
      } catch (cause) {
        const stillCurrent =
          searchContextRequests.current.isCurrent(requestLease) &&
          historyLru.current.includes(channelId);
        if (stillCurrent) {
          const currentWindow = historyWindows.current.get(channelId);
          if (currentWindow) {
            historyWindows.current.set(channelId, setContextLoading(currentWindow, null));
          }
          setHistoryRevision((value) => value + 1);
          setError(
            clientErrorMessage(
              cause,
              direction === "older"
                ? "Could not load earlier message context"
                : "Could not load later message context"
            )
          );
          throw cause;
        }
      }
    },
    [publishBootstrap, setHistoryViewport]
  );

  const loadOlder = useCallback(
    async (channelId: string, viewportMessageIds?: readonly string[]) => {
      const existing = histories.current.get(channelId);
      const window = historyWindows.current.get(channelId);
      if (viewportMessageIds) {
        setHistoryViewport(channelId, viewportMessageIds, "older-first");
      }
      if (window?.context) return loadContextPage(channelId, "older", viewportMessageIds);
      if (!existing || existing.loading || !existing.hasMore || !existing.beforeSequence) return;
      const startedAt = nextHistoryPageLoadStartedAt({
        now: performance.now(),
        lastStartedAt: historyLoadStartedAt.current.get(channelId) ?? null,
      });
      if (startedAt === null) return;
      historyLoadStartedAt.current.set(channelId, startedAt);
      const requestLease = historyRequests.current.supersede(channelId);
      const requestedBefore = existing.beforeSequence;
      histories.current.set(channelId, { ...existing, loading: true });
      setHistoryRevision((value) => value + 1);
      try {
        const page = await api.channelHistory(channelId, {
          beforeSequence: requestedBefore,
          limit: MESSAGE_HISTORY_PAGE_SIZE,
        });
        if (
          !historyRequests.current.isCurrent(requestLease) ||
          !historyLru.current.includes(channelId)
        ) {
          return;
        }
        const current = histories.current.get(channelId);
        if (!current || current.beforeSequence !== requestedBefore) return;
        const mergeStartedAt = performance.now();
        const transition = applyPrimaryHistoryPage({
          current,
          window: historyWindows.current.get(channelId),
          page,
          mode: "older",
          atBottom: false,
          viewport: historyViewports.current.get(channelId),
        });
        histories.current.set(channelId, transition.history);
        historyWindows.current.set(channelId, transition.window);
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
        const retained = retainedMessageWindowStats(transition.history, transition.window);
        const viewport = historyViewports.current.get(channelId);
        recordPerformance("history.page.merge", performance.now() - mergeStartedAt, {
          direction: "older",
          mode: transition.window.primaryHasNewerGap ? "history" : "latest",
          messages: transition.history.messages.length,
          retainedBytes: transition.window.retainedBytes,
          retainedMessages: retained.messages,
          viewportFill: "older-first",
          viewportProtected: viewport?.messageIds.size ?? 0,
          evictedOlder: transition.evictedOlder,
          evictedNewer: transition.evictedNewer,
        });
      } catch (cause) {
        const stillCurrent =
          historyRequests.current.isCurrent(requestLease) && historyLru.current.includes(channelId);
        if (stillCurrent) {
          const current = histories.current.get(channelId);
          if (current) histories.current.set(channelId, { ...current, loading: false });
          setHistoryRevision((value) => value + 1);
          setError(clientErrorMessage(cause, "Could not load earlier messages"));
          throw cause;
        }
      }
    },
    [loadContextPage, publishBootstrap, setHistoryViewport]
  );

  const loadNewer = useCallback(
    (channelId: string, viewportMessageIds?: readonly string[]) =>
      loadContextPage(channelId, "newer", viewportMessageIds),
    [loadContextPage]
  );

  const ensureMessageLoaded = useCallback(
    async (channelId: string, messageId: string): Promise<boolean> => {
      const snapshotHasTarget = Boolean(
        snapshotRef.current?.channelMessages.some(
          (message) => message.channelId === channelId && message.id === messageId
        )
      );
      const cached = histories.current.get(channelId);
      const targetIsPrimary = Boolean(cached?.messages.some((message) => message.id === messageId));
      if (targetIsPrimary) {
        if (cached && (cached.searchContext.length > 0 || cached.searchThreadContext.length > 0)) {
          const transition = clearMessageContext(
            cached,
            historyWindows.current.get(channelId) ?? emptyChannelMessageWindow()
          );
          histories.current.set(channelId, transition.history);
          historyWindows.current.set(channelId, transition.window);
          setHistoryRevision((value) => value + 1);
          publishBootstrap(true);
        }
        return true;
      }
      const targetIsBootstrapLatest = Boolean(
        bootstrapRef.current?.latestMessages.some((message) => message.id === messageId)
      );
      if (targetIsBootstrapLatest) {
        const window = historyWindows.current.get(channelId);
        if (cached && window && (window.context || window.primaryHasNewerGap)) {
          const tailHasTarget = window.latestTail?.messages.some(
            (message) => message.id === messageId
          );
          const reset = tailHasTarget ? resetToLatestTail(cached, window) : null;
          if (reset) {
            histories.current.set(channelId, reset.history);
            historyWindows.current.set(channelId, reset.window);
            setHistoryRevision((value) => value + 1);
            publishBootstrap(false);
          } else {
            touchHistory(channelId);
            await fetchChannel(channelId, true, true);
          }
        } else if (cached && cached.loadedAt > 0) {
          // A newest message the transcript does not contain yet is withheld
          // from it until a history read places it after its predecessors.
          touchHistory(channelId);
          await fetchChannel(channelId, false, true);
        }
        return true;
      }
      if (cached?.searchContext.some((message) => message.id === messageId)) return true;
      await loadChannel(channelId);
      const loaded = histories.current.get(channelId);
      if (loaded?.messages.some((message) => message.id === messageId)) return true;

      try {
        const contextLease = searchContextRequests.current.supersede(channelId);
        const context = await api.messageContext(messageId);
        if (context.channelId !== channelId) return false;
        if (!searchContextRequests.current.isCurrent(contextLease)) return false;
        const current = histories.current.get(channelId);
        if (!current || !historyLru.current.includes(channelId)) return false;
        const transition = enterMessageContext(
          current,
          historyWindows.current.get(channelId) ?? emptyChannelMessageWindow(),
          context
        );
        histories.current.set(channelId, transition.history);
        historyWindows.current.set(channelId, transition.window);
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
        return context.messages.some((message) => message.id === messageId);
      } catch (cause) {
        setError(clientErrorMessage(cause, "Could not load message context"));
        throw cause;
      }
    },
    [fetchChannel, loadChannel, publishBootstrap, touchHistory]
  );

  const clearSearchContext = useCallback(
    (channelId: string) => {
      searchContextRequests.current.invalidate(channelId);
      const current = histories.current.get(channelId);
      const window = historyWindows.current.get(channelId);
      if (
        !current ||
        !window ||
        (current.searchContext.length === 0 && current.searchThreadContext.length === 0)
      )
        return;
      const transition = clearMessageContext(current, window);
      histories.current.set(channelId, transition.history);
      historyWindows.current.set(channelId, transition.window);
      setHistoryRevision((value) => value + 1);
      publishBootstrap(true);
    },
    [publishBootstrap]
  );

  const jumpToLatest = useCallback(
    async (channelId: string) => {
      const current = histories.current.get(channelId);
      const window = historyWindows.current.get(channelId);
      if (!current || !window || (!window.context && !window.primaryHasNewerGap)) return;
      searchContextRequests.current.invalidate(channelId);
      historyRequests.current.invalidate(channelId);
      channelLoads.current.delete(channelId);
      const cached = current && window ? resetToLatestTail(current, window) : null;
      if (cached) {
        histories.current.set(channelId, cached.history);
        historyWindows.current.set(channelId, cached.window);
        setHistoryRevision((value) => value + 1);
        publishBootstrap(false);
        recordPerformance("history.latest.jump", 0, { source: "cache" });
        void fetchChannel(channelId, true, true).catch(() => undefined);
        return;
      }
      const startedAt = performance.now();
      await fetchChannel(channelId, true, true);
      recordPerformance("history.latest.jump", performance.now() - startedAt, {
        source: "network",
      });
    },
    [fetchChannel, publishBootstrap]
  );

  const setHistoryViewportAtBottom = useCallback((channelId: string, atBottom: boolean) => {
    historyViewportAtBottom.current.set(channelId, atBottom);
  }, []);

  const patchMessage = useCallback(
    (message: ChannelMessageView) => {
      let changed = false;
      for (const [channelId, history] of histories.current) {
        if (channelId !== message.channelId) continue;
        const window = historyWindows.current.get(channelId);
        if (!window) continue;
        const transition = patchRetainedMessageWindow(
          history,
          window,
          message,
          historyViewports.current.get(channelId)
        );
        if (!transition) continue;
        // A page started before this authoritative patch can carry an older
        // copy of the same boundary row. Invalidate both lanes and clear their
        // loading state through the pure reconciliation above before publish.
        historyRequests.current.invalidate(channelId);
        searchContextRequests.current.invalidate(channelId);
        channelLoads.current.delete(channelId);
        histories.current.set(channelId, transition.history);
        historyWindows.current.set(channelId, transition.window);
        changed = true;
      }
      const bootstrap = bootstrapRef.current;
      if (bootstrap) {
        const index = bootstrap.latestMessages.findIndex(
          (candidate) => candidate.id === message.id
        );
        if (index >= 0) {
          const latestMessages = bootstrap.latestMessages.slice();
          latestMessages[index] = message;
          bootstrapRef.current = { ...bootstrap, latestMessages };
          changed = true;
        }
      }
      if (!changed) return;
      setHistoryRevision((value) => value + 1);
      publishBootstrap(true);
    },
    [publishBootstrap]
  );

  const refresh = useCallback(
    async (quiet = false) => {
      refreshRequested.current = true;
      if (!quiet) {
        refreshNeedsForeground.current = true;
        setRefreshing(true);
      }
      if (refreshInFlight.current) return refreshInFlight.current;
      const task = (async () => {
        while (true) {
          while (refreshRequested.current) {
            const cycleQuiet = !refreshNeedsForeground.current;
            refreshRequested.current = false;
            refreshNeedsForeground.current = false;
            refreshError.current = null;
            try {
              // Until the first load lands, a silent server must turn into a message (and
              // the retry below) rather than an endless "Connecting".
              const bootstrap = await (snapshotRef.current
                ? api.bootstrap()
                : withDeadline((signal) => api.bootstrap(signal)));
              bootstrapRef.current = bootstrap;
              bootstrapEpoch.current += 1;
              cursor.current = bootstrap.cursor;
              lastRuntimePoll.current = Date.now();
              const validChannelIds = new Set(bootstrap.channels.map((channel) => channel.id));
              let removedInvalidHistory = false;
              historyLru.current = historyLru.current.filter((channelId) => {
                if (validChannelIds.has(channelId)) return true;
                invalidateHistory(channelId);
                removedInvalidHistory = true;
                return false;
              });
              if (removedInvalidHistory) {
                setHistoryRevision((value) => value + 1);
              }
              for (const [channelId, state] of channelStates.current) {
                if (
                  compareSequence({ sequence: state.revision }, { sequence: bootstrap.cursor }) <
                  0
                ) {
                  channelStates.current.delete(channelId);
                }
              }
              // Channel hydration is supplementary. Publish the bounded shell
              // first so a stale saved selection or a transient history error
              // can never strand the app on its connecting screen.
              publishBootstrap(cycleQuiet);
              const activeChannel = historyLru.current[0];
              if (
                activeChannel &&
                histories.current.has(activeChannel) &&
                openHistoryNeedsRead({
                  bootstrap,
                  channelId: activeChannel,
                  history: histories.current.get(activeChannel),
                  state: channelStates.current.get(activeChannel),
                  detachedMessageIds: detachedMessageIdsRef.current,
                  now: Date.now(),
                })
              ) {
                await fetchChannel(activeChannel, false, true);
              }
              void syncBackgroundHistories();
              setError(null);
              refreshError.current = null;
              lastRefreshCompletedAt.current = Date.now();
            } catch (cause) {
              refreshError.current = cause;
              setError(clientErrorMessage(cause, "Could not refresh OpenTeam"));
            }
          }
          // Let requests queued by promise continuations join this runner. Once
          // the ref is cleared, any later caller starts a new runner itself.
          await Promise.resolve();
          if (refreshRequested.current) continue;
          refreshInFlight.current = null;
          setRefreshing(false);
          return;
        }
      })();
      refreshInFlight.current = task;
      return task;
    },
    [fetchChannel, invalidateHistory, publishBootstrap, syncBackgroundHistories]
  );

  const reactToMessage = useCallback(
    async (messageId: string, emoji: string) => {
      setError(null);
      const previous = snapshotRef.current?.channelMessages.find(
        (message) => message.id === messageId
      );
      if (previous) patchMessage(toggleOwnReaction(previous, emoji));
      try {
        const result = await api.reactToMessage(messageId, emoji);
        patchMessage(result.message);
        return result;
      } catch (cause) {
        if (previous) patchMessage(previous);
        setError(clientErrorMessage(cause, "Could not update this reaction"));
        throw cause;
      }
    },
    [patchMessage, refresh]
  );

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retryIfNeeded = () => {
      if (!cancelled && !snapshotRef.current) {
        retryTimer = setTimeout(async () => {
          await refresh();
          retryIfNeeded();
        }, 3_000);
      }
    };
    // Effect remounts must reclaim retry ownership even when the initial
    // request is already running. The disposed effect cannot schedule it.
    const initial = initialRefreshStarted.current ? refreshInFlight.current : refresh();
    initialRefreshStarted.current = true;
    void Promise.resolve(initial).then(retryIfNeeded);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Snapshot presence starts one poller; refs and publishBootstrap carry the latest snapshot.
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void poll(), 30_000);
    };
    const poll = async () => {
      if (cancelled || polling) return;
      if (!isWindowVisible()) {
        schedule();
        return;
      }
      polling = true;
      try {
        const view = await api.runtime();
        lastRuntimePoll.current = Date.now();
        const bootstrap = bootstrapRef.current;
        if (bootstrap && JSON.stringify(bootstrap.runtime) !== JSON.stringify(view.runtime)) {
          bootstrapRef.current = { ...bootstrap, runtime: view.runtime };
          publishBootstrap(true);
        }
      } catch {
        // The next poll retries.
      } finally {
        polling = false;
        schedule();
      }
    };
    const pollWhenVisible = () => {
      if (!isWindowVisible() || Date.now() - lastRuntimePoll.current < 30_000)
        return;
      if (timer) clearTimeout(timer);
      void poll();
    };

    schedule();
    const pollNow = () => {
      if (timer) clearTimeout(timer);
      void poll();
    };
    window.addEventListener(WINDOW_VISIBILITY_EVENT, pollWhenVisible);
    window.addEventListener("focus", pollWhenVisible);
    window.addEventListener(RUNTIME_REFRESH_EVENT, pollNow);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener(WINDOW_VISIBILITY_EVENT, pollWhenVisible);
      window.removeEventListener("focus", pollWhenVisible);
      window.removeEventListener(RUNTIME_REFRESH_EVENT, pollNow);
    };
  }, [publishBootstrap, snapshot !== null]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Snapshot presence starts one live-sync controller; refresh and cursor refs carry current state.
  useEffect(() => {
    if (!snapshot) return;
    let streamHealthy = false;
    const liveSync = createDesktopLiveSyncController({
      cursor: () => cursor.current,
      synchronize: async () => {
        await refresh(true);
        if (refreshError.current) throw refreshError.current;
      },
      handleEvent: (productEvent) => {
        cursor.current = productEvent.sequence;
        return shouldRefreshForEvent(productEvent);
      },
      onHealthChange: (healthy) => {
        streamHealthy = healthy;
        setDesktopSendLiveTransportHealthy(healthy);
        setError(healthy ? null : "Live updates are reconnecting");
      },
    });
    // Where the stream keeps running in the background, every alt-tab used to
    // re-read bootstrap and the open conversation. Catch up only when the
    // stream may have missed something.
    const needsCatchUp = () =>
      !streamHealthy ||
      !window.openteam?.notifications ||
      Date.now() - lastRefreshCompletedAt.current >= FOCUS_REFRESH_AFTER_MS;
    const syncStreamVisibility = (synchronize = false) => {
      const visible = isWindowVisible();
      // Native alerts and remote-read dismissal depend on live state even when
      // the macOS window is hidden or minimized. Browser tabs may still suspend.
      liveSync.setActive(
        visible || Boolean(window.openteam?.notifications),
        visible && synchronize
      );
    };
    syncStreamVisibility();
    const syncAfterVisibilityChange = () => syncStreamVisibility(needsCatchUp());
    window.addEventListener(WINDOW_VISIBILITY_EVENT, syncAfterVisibilityChange);
    window.addEventListener("focus", syncAfterVisibilityChange);
    return () => {
      window.removeEventListener(WINDOW_VISIBILITY_EVENT, syncAfterVisibilityChange);
      window.removeEventListener("focus", syncAfterVisibilityChange);
      liveSync.stop();
    };
  }, [refresh, snapshot !== null]);

  useEffect(() => {
    const onAccepted = () => void refresh(true);
    window.addEventListener(DURABLE_SEND_ACCEPTED_EVENT, onAccepted);
    return () => window.removeEventListener(DURABLE_SEND_ACCEPTED_EVENT, onAccepted);
  }, [refresh]);

  const mutate = useCallback<OpenTeamMutation>(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        const result = await operation();
        await refresh(true);
        return result;
      } catch (cause) {
        setError(clientErrorMessage(cause, "OpenTeam could not complete this change"));
        throw cause;
      }
    },
    [refresh]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: The revision deliberately invalidates projections derived from mutable history refs.
  const historyByChannel = useMemo(() => {
    const status = new Map<string, ChannelHistoryStatus>();
    for (const [channelId, history] of histories.current) {
      const state = channelStates.current.get(channelId);
      const window = historyWindows.current.get(channelId) ?? emptyChannelMessageWindow();
      const context = window.context;
      status.set(channelId, {
        initialLoading: history.loading && history.loadedAt === 0,
        generation: window.generation,
        mode: context ? "context" : window.primaryHasNewerGap ? "history" : "latest",
        hasOlder: context?.hasMoreBefore ?? history.hasMore,
        hasNewer: context?.hasMoreAfter ?? false,
        hasNewerGap: context?.hasMoreAfter ?? window.primaryHasNewerGap,
        loadingOlder: context ? context.loadingDirection === "older" : history.loading,
        loadingNewer: context?.loadingDirection === "newer",
        loadedMessages: context ? history.searchContext.length : history.messages.length,
        retainedBytes: window.retainedBytes,
        activityTruncated: state?.truncated ? Object.values(state.truncated).some(Boolean) : false,
        threadContextTruncated: context
          ? history.searchThreadContextTruncated
          : history.threadContextTruncated,
      });
    }
    return status;
  }, [historyRevision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The revision deliberately invalidates projections derived from mutable history refs.
  const threadContextMessageIdsByChannel = useMemo(() => {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [channelId, history] of histories.current) {
      const ids = new Set<string>();
      const context = historyWindows.current.get(channelId)?.context;
      const visibleMessages = context ? history.searchContext : history.messages;
      const threadMessages = context ? history.searchThreadContext : history.threadContext;
      const visibleIds = new Set(visibleMessages.map((message) => message.id));
      for (const message of threadMessages) {
        if (!visibleIds.has(message.id)) ids.add(message.id);
      }
      const previous = threadContextIdsCache.current.get(channelId);
      next.set(channelId, previous && sameStringSet(previous, ids) ? previous : ids);
    }
    threadContextIdsCache.current = next;
    return next;
  }, [historyRevision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The revision deliberately invalidates projections derived from mutable history refs.
  const searchContextMessageIdsByChannel = useMemo(() => {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [channelId, history] of histories.current) {
      const ids = new Set<string>();
      for (const message of history.searchContext) ids.add(message.id);
      const previous = searchContextIdsCache.current.get(channelId);
      next.set(channelId, previous && sameStringSet(previous, ids) ? previous : ids);
    }
    searchContextIdsCache.current = next;
    return next;
  }, [historyRevision]);

  return {
    snapshot,
    detachedMessageIds,
    capabilities,
    error,
    refreshing,
    refresh,
    mutate,
    loadChannel,
    loadOlder,
    loadNewer,
    ensureMessageLoaded,
    clearSearchContext,
    jumpToLatest,
    setHistoryViewportAtBottom,
    setHistoryViewport,
    reactToMessage,
    historyByChannel,
    threadContextMessageIdsByChannel,
    searchContextMessageIdsByChannel,
  };
}
