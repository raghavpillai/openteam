export interface SerialPoller {
  start: () => void;
  stop: () => void;
  wake: () => void;
}

export const MAX_PARALLEL_UPLOADS = 2;

export interface SerialPollerOptions {
  intervalMs: number;
  task: () => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Poll without ever overlapping a slow request. */
export const createSerialPoller = ({
  intervalMs,
  task,
  schedule = setTimeout,
  cancel = clearTimeout,
}: SerialPollerOptions): SerialPoller => {
  let stopped = true;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (stopped || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await task();
    } catch {
      // Callers own user-facing error reporting. Transient errors do not stop polling.
    } finally {
      running = false;
      scheduleNext();
    }
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      void run();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    wake: () => {
      if (stopped || running) return;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      void run();
    },
  };
};

export const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  concurrency: number,
  worker: (item: Input, index: number) => Promise<Output>
): Promise<Output[]> => {
  if (items.length === 0) return [];
  const limit = Math.min(items.length, Math.max(1, Math.trunc(concurrency)));
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item !== undefined) results[index] = await worker(item, index);
      }
    })
  );
  return results;
};

export interface KeyedRequestLease {
  key: string;
  revision: number;
}

export interface KeyedRequestCoordinator {
  clear: () => void;
  invalidate: (key: string) => void;
  isCurrent: (lease: KeyedRequestLease) => boolean;
  pending: <T = unknown>(key: string) => Promise<T> | null;
  run: <T>(key: string, task: (lease: KeyedRequestLease) => Promise<T>) => Promise<T>;
  supersede: (key: string) => KeyedRequestLease;
}

/** Deduplicates same-key work while revision leases prevent stale results from committing. */
export const createKeyedRequestCoordinator = (): KeyedRequestCoordinator => {
  const revisions = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();

  const nextLease = (key: string, removePending: boolean): KeyedRequestLease => {
    const revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    if (removePending) pending.delete(key);
    return { key, revision };
  };

  const coordinator: KeyedRequestCoordinator = {
    clear: () => {
      for (const key of new Set([...revisions.keys(), ...pending.keys()])) {
        revisions.set(key, (revisions.get(key) ?? 0) + 1);
      }
      pending.clear();
    },
    invalidate: (key) => {
      nextLease(key, true);
    },
    isCurrent: ({ key, revision }) => revisions.get(key) === revision,
    pending: <T>(key: string) => (pending.get(key) as Promise<T> | undefined) ?? null,
    run: <T>(key: string, task: (lease: KeyedRequestLease) => Promise<T>): Promise<T> => {
      const existing = pending.get(key) as Promise<T> | undefined;
      if (existing) return existing;
      const lease = nextLease(key, false);
      let request!: Promise<T>;
      request = task(lease).finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
      pending.set(key, request);
      return request;
    },
    supersede: (key) => nextLease(key, true),
  };
  return coordinator;
};

export interface OperationLease<Client> {
  client: Client;
  epoch: number;
}

export const operationLeaseIsCurrent = <Client>(
  activeClient: Client | null,
  activeEpoch: number,
  lease: OperationLease<Client>
): boolean => activeClient === lease.client && activeEpoch === lease.epoch;

export interface SerializedBooleanController {
  release: () => void;
  resume: () => void;
  setDesired: (active: boolean) => void;
  whenIdle: () => Promise<void>;
}

export interface SerializedBooleanOptions<Result> {
  request: (active: boolean) => Promise<Result>;
  onBusyChange?: (busy: boolean) => void;
  onError?: (cause: unknown) => void;
  onResult?: (result: Result) => void;
}

/**
 * Serializes boolean writes and converges on the newest desired value. Release
 * always writes false, including when an earlier enable resolves after blur.
 */
export const createSerializedBooleanController = <Result>({
  request,
  onBusyChange,
  onError,
  onResult,
}: SerializedBooleanOptions<Result>): SerializedBooleanController => {
  let desired = false;
  let requestedRevision = 0;
  let settledRevision = 0;
  let running = false;
  let visible = false;
  let visibilityEpoch = 0;
  const idleWaiters = new Set<() => void>();

  const notifyBusy = () => {
    if (visible) onBusyChange?.(running || settledRevision < requestedRevision);
  };

  const settleIdleWaiters = () => {
    if (running || settledRevision < requestedRevision) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const drain = async () => {
    if (running || settledRevision >= requestedRevision) {
      notifyBusy();
      settleIdleWaiters();
      return;
    }
    running = true;
    notifyBusy();
    try {
      while (settledRevision < requestedRevision) {
        const attemptRevision = requestedRevision;
        const attemptDesired = desired;
        const attemptEpoch = visibilityEpoch;
        try {
          const result = await request(attemptDesired);
          if (
            visible &&
            attemptEpoch === visibilityEpoch &&
            attemptRevision === requestedRevision &&
            attemptDesired === desired
          ) {
            onResult?.(result);
          }
        } catch (cause) {
          if (
            visible &&
            attemptEpoch === visibilityEpoch &&
            attemptRevision === requestedRevision &&
            attemptDesired === desired
          ) {
            onError?.(cause);
          }
        } finally {
          settledRevision = attemptRevision;
        }
      }
    } finally {
      running = false;
      notifyBusy();
      settleIdleWaiters();
    }
  };

  return {
    release: () => {
      visible = false;
      visibilityEpoch += 1;
      desired = false;
      requestedRevision += 1;
      void drain();
    },
    resume: () => {
      if (visible) {
        notifyBusy();
        return;
      }
      visible = true;
      visibilityEpoch += 1;
      notifyBusy();
    },
    setDesired: (active) => {
      if (!visible && active) return;
      desired = active;
      requestedRevision += 1;
      void drain();
    },
    whenIdle: () => {
      if (!running && settledRevision >= requestedRevision) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
  };
};

/** Product-specific name retained for readable screen-control call sites. */
export const createSerializedTakeoverController = createSerializedBooleanController;
export type SerializedTakeoverController = SerializedBooleanController;
