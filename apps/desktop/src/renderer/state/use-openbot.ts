import type { ClientSnapshot } from "@openbot/contracts";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { shouldRefreshForEvent, subscribeToProductEvents } from "../client/event-stream";
import { api } from "../client/openbot-api";
import { recordPerformance } from "../lib/performance";
import { createSnapshotCaches, reconcileClientSnapshot } from "../lib/snapshot-reconcile";

export type OpenBotMutation = <T>(operation: () => Promise<T>) => Promise<T>;

const canRefreshInBackground = () => Boolean(window.openbot?.notifications);

export function useOpenBot() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const snapshotRef = useRef<ClientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const cursor = useRef("0");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const initialRefreshStarted = useRef(false);
  const lastRefreshAt = useRef(0);
  const caches = useRef(createSnapshotCaches());

  const refresh = useCallback(async (quiet = false) => {
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return refreshInFlight.current;
    }
    if (!quiet) setRefreshing(true);
    const task = (async () => {
      try {
        const incoming = await api.snapshot();
        cursor.current = incoming.cursor;
        const startedAt = performance.now();
        const next = reconcileClientSnapshot(incoming, snapshotRef.current, caches.current);
        const changed = next !== snapshotRef.current;
        const commit = () => {
          snapshotRef.current = next;
          setSnapshot((current) => (current === next ? current : next));
        };
        if (quiet) startTransition(commit);
        else commit();
        lastRefreshAt.current = performance.now();
        recordPerformance("snapshot.reconcile", performance.now() - startedAt, { changed });
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!quiet) setRefreshing(false);
      }
    })();
    refreshInFlight.current = task;
    await task;
    refreshInFlight.current = null;
    if (refreshAgain.current) {
      refreshAgain.current = false;
      await refresh(true);
    }
  }, []);

  useEffect(() => {
    if (!initialRefreshStarted.current) {
      initialRefreshStarted.current = true;
      void refresh();
    }
    const retry = window.setInterval(() => {
      const needsInitialSnapshot = !snapshotRef.current;
      const needsVisibleWatchdogRefresh =
        (document.visibilityState === "visible" || canRefreshInBackground()) &&
        performance.now() - lastRefreshAt.current > 10_000;
      if (needsInitialSnapshot || needsVisibleWatchdogRefresh) void refresh(true);
    }, 3_000);
    return () => window.clearInterval(retry);
  }, [refresh]);

  useEffect(() => {
    if (!snapshot) return;
    const unsubscribe = subscribeToProductEvents(cursor.current, {
      onEvent: (productEvent) => {
        cursor.current = productEvent.sequence;
        if (!shouldRefreshForEvent(productEvent)) return;
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          const loadedCursor = BigInt(snapshotRef.current?.cursor ?? "0");
          if (
            (document.visibilityState === "visible" || canRefreshInBackground()) &&
            loadedCursor < BigInt(productEvent.sequence)
          ) {
            void refresh(true);
          }
        }, 32);
      },
      onError: () => setError("Live updates are reconnecting"),
      onOpen: () => {
        setError(null);
        if (
          (document.visibilityState === "visible" || canRefreshInBackground()) &&
          !refreshInFlight.current &&
          performance.now() - lastRefreshAt.current > 500
        ) {
          void refresh(true);
        }
      },
    });
    return () => {
      unsubscribe();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, snapshot !== null]);

  useEffect(() => {
    const onVisibility = () => {
      if (
        (document.visibilityState === "visible" || canRefreshInBackground()) &&
        !refreshInFlight.current &&
        performance.now() - lastRefreshAt.current > 500
      ) {
        void refresh(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [refresh]);

  const mutate = useCallback<OpenBotMutation>(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        const result = await operation();
        await refresh(true);
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [refresh]
  );

  return { snapshot, error, refreshing, refresh, mutate };
}
