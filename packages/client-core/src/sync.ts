import type {
  ChannelClientState,
  ChannelHistoryPage,
  ClientBootstrapView,
  ProductEvent,
} from "@openteam/contracts";
import type { ProductEventHandlers } from "./events";

export const LIVE_SYNC_DEBOUNCE_MS = 50;
export const LIVE_SYNC_RECONNECT_MIN_MS = 1_000;
export const LIVE_SYNC_RECONNECT_MAX_MS = 30_000;
export const LIVE_SYNC_FALLBACK_MS = 60_000;
export const LIVE_SYNC_DEGRADED_FALLBACK_MS = 15_000;
export const RUNTIME_REFRESH_MS = 30_000;

export const shouldRefreshForEvent = (event: ProductEvent): boolean => {
  if (event.topic === "message.delta" || event.topic === "conversation.attached") return false;
  if (event.topic === "run_item.started" || event.topic === "run_item.completed") {
    const item = (event.payload as { item?: { type?: string } } | null)?.item;
    return !item?.type || !["agentMessage", "reasoning", "plan"].includes(item.type);
  }
  return true;
};

const numericCursor = (value: string): bigint | null =>
  /^\d+$/.test(value) ? BigInt(value) : null;

export const clientReadCoversCursor = (revision: string, cursor: string): boolean => {
  const read = numericCursor(revision);
  const required = numericCursor(cursor);
  return read !== null && required !== null && read >= required;
};

export interface LiveSnapshotSyncOptions {
  readBootstrap: () => Promise<ClientBootstrapView>;
  readHistory: (channelId: string) => Promise<ChannelHistoryPage>;
  readState: (channelId: string) => Promise<ChannelClientState>;
  activeChannel: () => string | null;
  historyIdentity: (channelId: string) => unknown;
  pendingHistory: (channelId: string) => Promise<unknown> | null;
  isCurrent: () => boolean;
  acceptBootstrap: (bootstrap: ClientBootstrapView) => boolean;
  acceptHistory: (history: ChannelHistoryPage) => void;
  acceptState: (state: ChannelClientState) => void;
  /** Request another read after competing work settles, even if no further event arrives. */
  defer: (pending?: Promise<unknown>) => void;
}

/** Do not mistake a newer bootstrap cursor for a successfully refreshed conversation. */
export const synchronizeClientSnapshot = async (
  options: LiveSnapshotSyncOptions
): Promise<"applied" | "deferred" | "stale"> => {
  const channelId = options.activeChannel();
  const pending = channelId ? options.pendingHistory(channelId) : null;
  const historyIdentity = channelId ? options.historyIdentity(channelId) : undefined;
  const [bootstrap, history, state] = await Promise.all([
    options.readBootstrap(),
    channelId && !pending ? options.readHistory(channelId) : Promise.resolve(null),
    channelId && !pending ? options.readState(channelId) : Promise.resolve(null),
  ]);
  if (!options.isCurrent()) return "stale";
  if (!options.acceptBootstrap(bootstrap)) {
    options.defer();
    return "deferred";
  }
  if (
    !channelId ||
    options.activeChannel() !== channelId ||
    !bootstrap.channels.some((channel) => channel.id === channelId)
  )
    return "applied";
  // Paging must not hold up global previews/unread state. Only defer the
  // competing conversation read, and catch it up when that work settles.
  const competing = options.pendingHistory(channelId) ?? pending;
  if (
    competing ||
    options.historyIdentity(channelId) !== historyIdentity ||
    !history ||
    !state ||
    history.channelId !== channelId ||
    state.channelId !== channelId ||
    !clientReadCoversCursor(history.revision, bootstrap.cursor) ||
    !clientReadCoversCursor(state.revision, bootstrap.cursor)
  ) {
    options.defer(competing ?? undefined);
    return "deferred";
  }
  options.acceptHistory(history);
  options.acceptState(state);
  return "applied";
};

export class CommittedEventCursor {
  private committed = 0n;
  private observed = 0n;

  reset(value = "0"): void {
    const cursor = numericCursor(value) ?? 0n;
    this.committed = cursor;
    this.observed = cursor;
  }

  observe(value: string): void {
    const cursor = numericCursor(value);
    if (cursor !== null && cursor > this.observed) this.observed = cursor;
  }

  commit(value: string): boolean {
    const cursor = numericCursor(value);
    if (cursor === null || cursor < this.committed || cursor < this.observed) return false;
    this.committed = cursor;
    if (cursor > this.observed) this.observed = cursor;
    return true;
  }

  /** An authoritative server replacement cursor may intentionally move backward. */
  requireSnapshot(value: string): void {
    this.reset(value);
  }

  reconnectAfter(): string {
    return this.committed.toString();
  }

  observedThrough(): string {
    return this.observed.toString();
  }
}

export class TrailingAsyncCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private pending = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly delayMs = LIVE_SYNC_DEBOUNCE_MS
  ) {}

  trigger(): void {
    this.pending = true;
    // Bound event-to-refresh latency even when a busy workspace never goes
    // quiet. Keep the first timer instead of debouncing every event forever.
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
      if (this.pending) await this.flush();
      return;
    }
    if (!this.pending) return;
    this.pending = false;
    this.running = this.task().finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.pending) await this.flush();
  }

  cancel(): void {
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const reconnectDelay = (attempt: number, jitter = Math.random()): number => {
  const exponential = Math.min(
    LIVE_SYNC_RECONNECT_MAX_MS,
    LIVE_SYNC_RECONNECT_MIN_MS * 2 ** Math.max(0, Math.trunc(attempt))
  );
  return Math.round(exponential * (0.8 + Math.min(1, Math.max(0, jitter)) * 0.4));
};

export interface ReconnectingProductEventStream {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  wake: () => void;
}

export interface ReconnectingProductEventStreamOptions {
  cursor: () => string;
  listen: (after: string, handlers: ProductEventHandlers, signal: AbortSignal) => Promise<void>;
  onEvent: (event: ProductEvent) => void;
  onOpen?: () => void;
  onDisconnect?: (cause?: unknown) => void;
  onStreamError?: (message: string) => void;
  delayForAttempt?: (attempt: number) => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface LiveSyncController {
  /** Enable or suspend live work. Pass synchronize=true after returning to the foreground. */
  setActive: (active: boolean, synchronize?: boolean) => void;
  requestSync: () => void;
  flush: () => Promise<void>;
  stop: () => void;
}

export interface LiveSyncControllerOptions {
  cursor: () => string;
  listen: ReconnectingProductEventStreamOptions["listen"];
  synchronize: () => Promise<void>;
  /** Return true when this event invalidates snapshot-backed client state. */
  handleEvent: (event: ProductEvent) => boolean;
  isCurrent?: () => boolean;
  onHealthChange?: (healthy: boolean, cause?: unknown) => void;
  onStreamError?: (message: string) => void;
  debounceMs?: number;
  healthyFallbackMs?: number;
  degradedFallbackMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  delayForReconnectAttempt?: (attempt: number) => number;
  delayForSyncRetryAttempt?: (attempt: number) => number;
}

/** Fetch-backed SSE lifecycle. Apps still decide when foreground/background permits a connection. */
export const createReconnectingProductEventStream = ({
  cursor,
  listen,
  onEvent,
  onOpen,
  onDisconnect,
  onStreamError,
  delayForAttempt = reconnectDelay,
  schedule = setTimeout,
  cancel = clearTimeout,
}: ReconnectingProductEventStreamOptions): ReconnectingProductEventStream => {
  let active = false;
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReconnect = () => {
    if (reconnectTimer === null) return;
    cancel(reconnectTimer);
    reconnectTimer = null;
  };

  const connect = () => {
    if (!active || stopped || controller || reconnectTimer !== null) return;
    const current = new AbortController();
    controller = current;
    let disconnectCause: unknown;
    const isCurrent = () => !current.signal.aborted && controller === current;
    void Promise.resolve()
      .then(() =>
        listen(
          cursor(),
          {
            onEvent: (event) => {
              if (isCurrent()) onEvent(event);
            },
            onOpen: () => {
              if (!isCurrent()) return;
              attempt = 0;
              onOpen?.();
            },
            onStreamError: (message) => {
              if (isCurrent()) onStreamError?.(message);
            },
          },
          current.signal
        )
      )
      .catch((cause) => {
        disconnectCause = cause;
      })
      .finally(() => {
        if (controller === current) controller = null;
        if (current.signal.aborted || !active || stopped) return;
        onDisconnect?.(disconnectCause);
        const delay = delayForAttempt(attempt);
        attempt += 1;
        reconnectTimer = schedule(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      });
  };

  const pause = () => {
    active = false;
    clearReconnect();
    controller?.abort();
    controller = null;
  };

  return {
    pause,
    resume: () => {
      if (stopped) return;
      active = true;
      connect();
    },
    stop: () => {
      stopped = true;
      pause();
    },
    wake: () => {
      if (stopped || !active || controller) return;
      clearReconnect();
      connect();
    },
  };
};

/**
 * Shared live-data policy for every client. Platforms only adapt their API listener and
 * foreground lifecycle; reconnect catch-up, coalescing, and fallback polling stay identical.
 */
export const createLiveSyncController = ({
  cursor,
  listen,
  synchronize,
  handleEvent,
  isCurrent = () => true,
  onHealthChange,
  onStreamError,
  debounceMs = LIVE_SYNC_DEBOUNCE_MS,
  healthyFallbackMs = LIVE_SYNC_FALLBACK_MS,
  degradedFallbackMs = LIVE_SYNC_DEGRADED_FALLBACK_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  delayForReconnectAttempt,
  delayForSyncRetryAttempt = reconnectDelay,
}: LiveSyncControllerOptions): LiveSyncController => {
  let active = false;
  let stopped = false;
  let streamHealthy = false;
  let reconnectNeedsSync = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let syncRetryAttempt = 0;

  const clearSyncRetry = () => {
    if (syncRetryTimer !== null) cancel(syncRetryTimer);
    syncRetryTimer = null;
  };

  const coalescer = new TrailingAsyncCoalescer(async () => {
    if (!active || stopped || !isCurrent()) return;
    clearSyncRetry();
    try {
      await synchronize();
      syncRetryAttempt = 0;
    } catch {
      // An open event transport is not proof that the snapshot read succeeded.
      // Retry the final update even when no subsequent event will wake us.
      if (!active || stopped || !isCurrent()) return;
      syncRetryTimer = schedule(() => {
        syncRetryTimer = null;
        if (active && !stopped && isCurrent()) coalescer.trigger();
      }, delayForSyncRetryAttempt(syncRetryAttempt++));
    }
  }, debounceMs);

  const clearFallback = () => {
    if (fallbackTimer === null) return;
    cancel(fallbackTimer);
    fallbackTimer = null;
  };

  const scheduleFallback = () => {
    clearFallback();
    if (!active || stopped || !isCurrent()) return;
    fallbackTimer = schedule(
      () => {
        fallbackTimer = null;
        if (active && !stopped && isCurrent()) coalescer.trigger();
        scheduleFallback();
      },
      streamHealthy ? healthyFallbackMs : degradedFallbackMs
    );
  };

  const markDisconnected = (cause?: unknown) => {
    if (stopped || !isCurrent()) return;
    streamHealthy = false;
    reconnectNeedsSync = true;
    onHealthChange?.(false, cause);
    scheduleFallback();
  };

  const stream = createReconnectingProductEventStream({
    cursor,
    listen,
    onOpen: () => {
      if (stopped || !isCurrent()) return;
      streamHealthy = true;
      onHealthChange?.(true);
      scheduleFallback();
      if (reconnectNeedsSync) {
        reconnectNeedsSync = false;
        coalescer.trigger();
      }
    },
    onEvent: (event) => {
      if (stopped || !isCurrent()) return;
      streamHealthy = true;
      if (handleEvent(event)) coalescer.trigger();
    },
    onDisconnect: markDisconnected,
    onStreamError: (message) => {
      onStreamError?.(message);
      markDisconnected(message);
    },
    schedule,
    cancel,
    ...(delayForReconnectAttempt ? { delayForAttempt: delayForReconnectAttempt } : {}),
  });

  return {
    setActive: (nextActive, synchronizeAfterResume = false) => {
      if (stopped) return;
      active = nextActive;
      if (!active) {
        stream.pause();
        coalescer.cancel();
        clearFallback();
        clearSyncRetry();
        return;
      }
      if (synchronizeAfterResume) {
        reconnectNeedsSync = false;
        coalescer.trigger();
      }
      stream.resume();
      scheduleFallback();
    },
    requestSync: () => {
      if (active && !stopped && isCurrent()) coalescer.trigger();
    },
    flush: () => coalescer.flush(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      active = false;
      stream.stop();
      coalescer.cancel();
      clearFallback();
      clearSyncRetry();
    },
  };
};
