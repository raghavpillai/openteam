import { createKeyedRequestCoordinator } from "@openbot/client-core";
import type { ChannelMessageView, ClientSnapshot } from "@openbot/contracts";
import { CLIENT_CAPABILITIES, type ClientCapabilities } from "@openbot/contracts/capabilities";
import {
  clearLoadedChannelSearchContext,
  compareEntitySequence as compareSequence,
  loadedChannelHistoryMessages,
  loadingChannelHistory,
  mergeBootstrapActivityStates,
  mergeLoadedChannelHistoryPage,
  mergeLoadedChannelMessageContext,
  type LoadedChannelHistory,
  uniqueEntitiesById as mergeEntities,
} from "@openbot/product-core/history";
import { toggleOwnReaction } from "@openbot/product-core/messages";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDesktopLiveSyncController, shouldRefreshForEvent } from "../client/event-stream";
import { ClientError } from "../client/http";
import { api, type ChannelClientState, type ClientBootstrapView } from "../client/openbot-api";
import { DURABLE_SEND_ACCEPTED_EVENT } from "../lib/durable-sends";
import { nextHistoryPageLoadStartedAt } from "../lib/history-pagination";
import { recordPerformance } from "../lib/performance";
import { createSnapshotCaches, reconcileClientSnapshot } from "../lib/snapshot-reconcile";

export type OpenBotMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface ChannelHistoryStatus {
  hasMore: boolean;
  loading: boolean;
  loadedMessages: number;
  activityTruncated: boolean;
  threadContextTruncated: boolean;
}

const HISTORY_PAGE_SIZE = 100;
const MAX_WARM_HISTORIES = 3;

const sameCapabilities = (left: ClientCapabilities, right: ClientCapabilities) =>
  left.uploads.maxAttachmentsPerMessage === right.uploads.maxAttachmentsPerMessage &&
  left.uploads.maxRegularBytes === right.uploads.maxRegularBytes &&
  left.uploads.maxVideoBytes === right.uploads.maxVideoBytes;

const sameStringSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
};

const bootstrapSnapshot = (
  bootstrap: ClientBootstrapView,
  histories: ReadonlyMap<string, LoadedChannelHistory>,
  channelStates: ReadonlyMap<string, ChannelClientState>
): ClientSnapshot => {
  const latestByChannel = new Map(
    bootstrap.latestMessages.map((message) => [message.channelId, message] as const)
  );
  const channelMessages = bootstrap.channels.flatMap((channel) => {
    const latest = latestByChannel.get(channel.id);
    const loaded = histories.get(channel.id);
    if (!loaded) return latest ? [latest] : [];
    return mergeEntities(loadedChannelHistoryMessages(loaded), latest ? [latest] : []).sort(
      compareSequence
    );
  });
  const states = [...channelStates.values()];
  const activity = mergeBootstrapActivityStates(bootstrap, states);
  return {
    cursor: bootstrap.cursor,
    workspace: bootstrap.workspace,
    bots: bootstrap.bots,
    channels: bootstrap.channels,
    channelMessages,
    ...activity,
    runtime: bootstrap.runtime,
  };
};

export function useOpenBot() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const snapshotRef = useRef<ClientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [capabilities, setCapabilities] = useState<ClientCapabilities>(CLIENT_CAPABILITIES);
  const [historyRevision, setHistoryRevision] = useState(0);
  const cursor = useRef("0");
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshRequested = useRef(false);
  const refreshNeedsForeground = useRef(false);
  const initialRefreshStarted = useRef(false);
  const legacyMode = useRef(false);
  const bootstrapRef = useRef<ClientBootstrapView | null>(null);
  const bootstrapEpoch = useRef(0);
  const histories = useRef(new Map<string, LoadedChannelHistory>());
  const channelStates = useRef(new Map<string, ChannelClientState>());
  const channelLoads = useRef(new Map<string, Promise<void>>());
  const historyRequests = useRef(createKeyedRequestCoordinator());
  const historyLoadStartedAt = useRef(new Map<string, number>());
  const searchContextRequests = useRef(createKeyedRequestCoordinator());
  const historyLru = useRef<string[]>([]);
  const threadContextIdsCache = useRef(new Map<string, ReadonlySet<string>>());
  const searchContextIdsCache = useRef(new Map<string, ReadonlySet<string>>());
  const caches = useRef(createSnapshotCaches());
  const runtimeEndpointMissing = useRef(false);
  const lastRuntimePoll = useRef(0);

  const publish = useCallback((incoming: ClientSnapshot, quiet: boolean) => {
    const startedAt = performance.now();
    const next = reconcileClientSnapshot(incoming, snapshotRef.current, caches.current);
    const changed = next !== snapshotRef.current;
    const commit = () => {
      snapshotRef.current = next;
      setSnapshot((current) => (current === next ? current : next));
    };
    if (quiet) startTransition(commit);
    else commit();
    recordPerformance("snapshot.reconcile", performance.now() - startedAt, {
      changed,
      mode: legacyMode.current ? "legacy" : "bounded",
      messages: next.channelMessages.length,
    });
  }, []);

  const publishBootstrap = useCallback(
    (quiet: boolean) => {
      const bootstrap = bootstrapRef.current;
      if (!bootstrap) return;
      const nextCapabilities = bootstrap.capabilities ?? CLIENT_CAPABILITIES;
      setCapabilities((current) =>
        sameCapabilities(current, nextCapabilities) ? current : nextCapabilities
      );
      publish(bootstrapSnapshot(bootstrap, histories.current, channelStates.current), quiet);
    },
    [publish]
  );

  const invalidateHistory = useCallback((channelId: string) => {
    historyRequests.current.invalidate(channelId);
    searchContextRequests.current.invalidate(channelId);
    histories.current.delete(channelId);
    channelStates.current.delete(channelId);
    historyLoadStartedAt.current.delete(channelId);
    // The request cannot be cancelled here, but removing it lets a later
    // selection start a current request. Its epoch guard prevents the old
    // promise from repopulating an evicted cache.
    channelLoads.current.delete(channelId);
  }, []);

  const touchHistory = useCallback(
    (channelId: string) => {
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

  const fetchChannel = useCallback(
    async (channelId: string, replaceHistory: boolean, quiet: boolean) => {
      const existingLoad = channelLoads.current.get(channelId);
      if (existingLoad) return existingLoad;
      const requestLease = historyRequests.current.supersede(channelId);
      const existing = histories.current.get(channelId);
      histories.current.set(channelId, loadingChannelHistory(existing));
      setHistoryRevision((value) => value + 1);
      let task!: Promise<void>;
      task = (async () => {
        try {
          let page!: Awaited<ReturnType<typeof api.channelHistory>>;
          let state!: Awaited<ReturnType<typeof api.channelState>>;
          let stateIsCurrent = true;
          // A saved channel can begin hydrating before bootstrap. If bootstrap
          // advances while that request is in flight, retry once against the
          // now-known cursor instead of letting its older state win the merge.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const requestBootstrapEpoch = bootstrapEpoch.current;
            [page, state] = await Promise.all([
              api.channelHistory(channelId, { limit: HISTORY_PAGE_SIZE }),
              api.channelState(channelId),
            ]);
            if (
              !historyRequests.current.isCurrent(requestLease) ||
              !historyLru.current.includes(channelId)
            ) {
              return;
            }
            const bootstrapCursor = bootstrapRef.current?.cursor;
            // History/state revisions are the global event high-water mark
            // observed by those reads. A request that straddled bootstrap is
            // still safe when both endpoint reads observed its cursor.
            stateIsCurrent =
              requestBootstrapEpoch === bootstrapEpoch.current ||
              !bootstrapCursor ||
              (compareSequence({ sequence: page.revision }, { sequence: bootstrapCursor }) >= 0 &&
                compareSequence({ sequence: state.revision }, { sequence: bootstrapCursor }) >= 0);
            if (stateIsCurrent || attempt === 1) break;
          }
          const current = histories.current.get(channelId);
          const shouldReplace = replaceHistory || !current || current.loadedAt === 0;
          histories.current.set(
            channelId,
            mergeLoadedChannelHistoryPage(current, page, shouldReplace ? "replace" : "refresh")
          );
          if (stateIsCurrent) channelStates.current.set(channelId, state);
          else channelStates.current.delete(channelId);
          setHistoryRevision((value) => value + 1);
          publishBootstrap(quiet);
        } catch (cause) {
          const stillCurrent =
            historyRequests.current.isCurrent(requestLease) &&
            historyLru.current.includes(channelId);
          if (stillCurrent) {
            const current = histories.current.get(channelId);
            if (current) histories.current.set(channelId, { ...current, loading: false });
            setHistoryRevision((value) => value + 1);
            setError(clientErrorMessage(cause, "Could not load this conversation"));
            throw cause;
          }
        }
      })().finally(() => {
        if (channelLoads.current.get(channelId) === task) {
          channelLoads.current.delete(channelId);
        }
      });
      channelLoads.current.set(channelId, task);
      return task;
    },
    [publishBootstrap]
  );

  const loadChannel = useCallback(
    async (channelId: string) => {
      if (legacyMode.current) return;
      const bootstrap = bootstrapRef.current;
      if (bootstrap && !bootstrap.channels.some((channel) => channel.id === channelId)) return;
      touchHistory(channelId);
      let existing = histories.current.get(channelId);
      if (
        existing &&
        (existing.searchContext.length > 0 || existing.searchThreadContext.length > 0)
      ) {
        existing = clearLoadedChannelSearchContext(existing);
        histories.current.set(channelId, existing);
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
      }
      await fetchChannel(channelId, !existing || existing.loadedAt === 0, true);
    },
    [fetchChannel, publishBootstrap, touchHistory]
  );

  const loadOlder = useCallback(
    async (channelId: string) => {
      if (legacyMode.current) return;
      const existing = histories.current.get(channelId);
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
          limit: HISTORY_PAGE_SIZE,
        });
        if (
          !historyRequests.current.isCurrent(requestLease) ||
          !historyLru.current.includes(channelId)
        ) {
          return;
        }
        const current = histories.current.get(channelId);
        if (!current || current.beforeSequence !== requestedBefore) return;
        histories.current.set(channelId, mergeLoadedChannelHistoryPage(current, page, "older"));
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
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
    [publishBootstrap]
  );

  const ensureMessageLoaded = useCallback(
    async (channelId: string, messageId: string): Promise<boolean> => {
      const contextLease = searchContextRequests.current.supersede(channelId);
      const snapshotHasTarget = Boolean(
        snapshotRef.current?.channelMessages.some(
          (message) => message.channelId === channelId && message.id === messageId
        )
      );
      if (legacyMode.current) return snapshotHasTarget;
      const cached = histories.current.get(channelId);
      const targetIsPrimary = Boolean(
        cached?.messages.some((message) => message.id === messageId) ||
          bootstrapRef.current?.latestMessages.some((message) => message.id === messageId)
      );
      if (targetIsPrimary) {
        if (cached && (cached.searchContext.length > 0 || cached.searchThreadContext.length > 0)) {
          histories.current.set(channelId, clearLoadedChannelSearchContext(cached));
          setHistoryRevision((value) => value + 1);
          publishBootstrap(true);
        }
        return true;
      }
      if (cached?.searchContext.some((message) => message.id === messageId)) return true;
      await loadChannel(channelId);
      const loaded = histories.current.get(channelId);
      if (loaded?.messages.some((message) => message.id === messageId)) return true;

      try {
        const context = await api.messageContext(messageId);
        if (context.channelId !== channelId) return false;
        if (!searchContextRequests.current.isCurrent(contextLease)) return false;
        const current = histories.current.get(channelId);
        if (!current || !historyLru.current.includes(channelId)) return false;
        histories.current.set(channelId, mergeLoadedChannelMessageContext(current, context));
        setHistoryRevision((value) => value + 1);
        publishBootstrap(true);
        return context.messages.some((message) => message.id === messageId);
      } catch (cause) {
        setError(clientErrorMessage(cause, "Could not load message context"));
        throw cause;
      }
    },
    [loadChannel, publishBootstrap]
  );

  const clearSearchContext = useCallback(
    (channelId: string) => {
      searchContextRequests.current.invalidate(channelId);
      const current = histories.current.get(channelId);
      if (
        !current ||
        (current.searchContext.length === 0 && current.searchThreadContext.length === 0)
      )
        return;
      histories.current.set(channelId, clearLoadedChannelSearchContext(current));
      setHistoryRevision((value) => value + 1);
      publishBootstrap(true);
    },
    [publishBootstrap]
  );

  const patchMessage = useCallback(
    (message: ChannelMessageView) => {
      let changed = false;
      for (const [channelId, history] of histories.current) {
        if (channelId !== message.channelId) continue;
        const primaryIndex = history.messages.findIndex((candidate) => candidate.id === message.id);
        const contextIndex = history.threadContext.findIndex(
          (candidate) => candidate.id === message.id
        );
        const searchIndex = history.searchContext.findIndex(
          (candidate) => candidate.id === message.id
        );
        const searchThreadIndex = history.searchThreadContext.findIndex(
          (candidate) => candidate.id === message.id
        );
        let nextHistory = history;
        if (primaryIndex >= 0) {
          const messages = nextHistory.messages.slice();
          messages[primaryIndex] = message;
          nextHistory = { ...nextHistory, messages };
        }
        if (searchIndex >= 0) {
          const searchContext = nextHistory.searchContext.slice();
          searchContext[searchIndex] = message;
          nextHistory = { ...nextHistory, searchContext };
        }
        if (contextIndex >= 0) {
          const threadContext = nextHistory.threadContext.slice();
          threadContext[contextIndex] = message;
          nextHistory = { ...nextHistory, threadContext };
        }
        if (searchThreadIndex >= 0) {
          const searchThreadContext = nextHistory.searchThreadContext.slice();
          searchThreadContext[searchThreadIndex] = message;
          nextHistory = { ...nextHistory, searchThreadContext };
        }
        if (nextHistory !== history) {
          histories.current.set(channelId, nextHistory);
          changed = true;
        }
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
            try {
              if (legacyMode.current) {
                const incoming = await api.snapshot();
                cursor.current = incoming.cursor;
                publish(incoming, cycleQuiet);
              } else {
                let bootstrap: ClientBootstrapView;
                try {
                  bootstrap = await api.bootstrap();
                } catch (cause) {
                  if (!(cause instanceof ClientError) || cause.status !== 404) throw cause;
                  legacyMode.current = true;
                  const incoming = await api.snapshot();
                  cursor.current = incoming.cursor;
                  publish(incoming, cycleQuiet);
                  continue;
                }
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
                if (activeChannel && histories.current.has(activeChannel)) {
                  const history = histories.current.get(activeChannel);
                  const state = channelStates.current.get(activeChannel);
                  // The saved channel can begin loading before bootstrap resolves.
                  // Reuse that just-completed page instead of immediately issuing
                  // the same history/state pair a second time during startup.
                  if (
                    !history ||
                    Date.now() - history.loadedAt >= 250 ||
                    !state ||
                    compareSequence({ sequence: state.revision }, { sequence: bootstrap.cursor }) <
                      0
                  ) {
                    await fetchChannel(activeChannel, false, true);
                  }
                }
              }
              setError(null);
            } catch (cause) {
              setError(clientErrorMessage(cause, "Could not refresh OpenBot"));
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
    [fetchChannel, invalidateHistory, publish, publishBootstrap]
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
        // Rolling upgrades can pair the new renderer with the legacy reaction
        // response, which did not include the authoritative message.
        if (result.message) patchMessage(result.message);
        else await refresh(true);
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
    if (initialRefreshStarted.current) return;
    initialRefreshStarted.current = true;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const start = async () => {
      await refresh();
      if (!cancelled && !snapshotRef.current) retryTimer = setTimeout(start, 3_000);
    };
    void start();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!snapshot || legacyMode.current || runtimeEndpointMissing.current) return;
    let cancelled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void poll(), 30_000);
    };
    const poll = async () => {
      if (cancelled || polling || runtimeEndpointMissing.current) return;
      if (document.visibilityState !== "visible") {
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
      } catch (cause) {
        if (cause instanceof ClientError && cause.status === 404) {
          runtimeEndpointMissing.current = true;
        }
      } finally {
        polling = false;
        schedule();
      }
    };
    const pollWhenVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastRuntimePoll.current < 30_000)
        return;
      if (timer) clearTimeout(timer);
      void poll();
    };

    schedule();
    document.addEventListener("visibilitychange", pollWhenVisible);
    window.addEventListener("focus", pollWhenVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", pollWhenVisible);
      window.removeEventListener("focus", pollWhenVisible);
    };
  }, [publishBootstrap, snapshot !== null]);

  useEffect(() => {
    if (!snapshot) return;
    const liveSync = createDesktopLiveSyncController({
      cursor: () => cursor.current,
      synchronize: () => refresh(true),
      handleEvent: (productEvent) => {
        cursor.current = productEvent.sequence;
        return shouldRefreshForEvent(productEvent);
      },
      onHealthChange: (healthy) => {
        setError(healthy ? null : "Live updates are reconnecting");
      },
    });
    const syncStreamVisibility = (synchronize = false) => {
      const visible = document.visibilityState === "visible";
      liveSync.setActive(visible, visible && synchronize);
    };
    syncStreamVisibility();
    const syncAfterVisibilityChange = () => syncStreamVisibility(true);
    document.addEventListener("visibilitychange", syncAfterVisibilityChange);
    window.addEventListener("focus", syncAfterVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", syncAfterVisibilityChange);
      window.removeEventListener("focus", syncAfterVisibilityChange);
      liveSync.stop();
    };
  }, [refresh, snapshot !== null]);

  useEffect(() => {
    const onAccepted = () => void refresh(true);
    window.addEventListener(DURABLE_SEND_ACCEPTED_EVENT, onAccepted);
    return () => window.removeEventListener(DURABLE_SEND_ACCEPTED_EVENT, onAccepted);
  }, [refresh]);

  const mutate = useCallback<OpenBotMutation>(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        const result = await operation();
        await refresh(true);
        return result;
      } catch (cause) {
        setError(clientErrorMessage(cause, "OpenBot could not complete this change"));
        throw cause;
      }
    },
    [refresh]
  );

  const historyByChannel = useMemo(() => {
    const status = new Map<string, ChannelHistoryStatus>();
    for (const [channelId, history] of histories.current) {
      const state = channelStates.current.get(channelId);
      status.set(channelId, {
        hasMore: history.hasMore,
        loading: history.loading,
        loadedMessages: history.messages.length,
        activityTruncated: state?.truncated ? Object.values(state.truncated).some(Boolean) : false,
        threadContextTruncated:
          history.threadContextTruncated || history.searchThreadContextTruncated,
      });
    }
    return status;
  }, [historyRevision]);

  const threadContextMessageIdsByChannel = useMemo(() => {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [channelId, history] of histories.current) {
      const ids = new Set<string>();
      const visibleIds = new Set([
        ...history.messages.map((message) => message.id),
        ...history.searchContext.map((message) => message.id),
      ]);
      for (const message of [...history.threadContext, ...history.searchThreadContext]) {
        if (!visibleIds.has(message.id)) ids.add(message.id);
      }
      const previous = threadContextIdsCache.current.get(channelId);
      next.set(channelId, previous && sameStringSet(previous, ids) ? previous : ids);
    }
    threadContextIdsCache.current = next;
    return next;
  }, [historyRevision]);

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
    capabilities,
    error,
    refreshing,
    refresh,
    mutate,
    loadChannel,
    loadOlder,
    ensureMessageLoaded,
    clearSearchContext,
    reactToMessage,
    historyByChannel,
    threadContextMessageIdsByChannel,
    searchContextMessageIdsByChannel,
  };
}
