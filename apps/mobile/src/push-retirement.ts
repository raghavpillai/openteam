export interface PushRetirement {
  bounded: Promise<void>;
  eventual: Promise<void>;
}

const settleWithin = async (task: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const completed = await Promise.race([
    task.then(
      () => true,
      () => true
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
};

/**
 * Waits briefly for issued registrations before unregistering. If the bound is
 * exceeded, a second cleanup runs after those registrations eventually settle.
 */
export const coordinatePushRetirement = (
  pendingOperations: readonly Promise<unknown>[],
  cleanup: () => Promise<unknown>,
  timeoutMs: number
): PushRetirement => {
  const drained = Promise.allSettled(pendingOperations);
  let timedOut = false;
  let decide!: () => void;
  const decision = new Promise<void>((resolve) => {
    decide = resolve;
  });
  const eventual = Promise.all([drained, decision]).then(async () => {
    if (timedOut) await cleanup();
  });
  const bounded = (async () => {
    timedOut = !(await settleWithin(drained, timeoutMs));
    decide();
    await settleWithin(Promise.resolve().then(cleanup), timeoutMs);
  })();
  return { bounded, eventual };
};
