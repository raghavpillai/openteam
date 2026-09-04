import type { MarkChannelReadView } from "@openteam/contracts";

const numericSequence = (value: string | undefined): bigint | null =>
  value !== undefined && /^\d+$/.test(value) ? BigInt(value) : null;

/** Clamp a visible read watermark to the newest message the client actually knows. */
export const readReceiptTarget = (latest: string | null, requested?: string): string | null => {
  const end = numericSequence(latest ?? undefined);
  const target = requested === undefined ? end : numericSequence(requested);
  return end === null || target === null ? null : (target < end ? target : end).toString();
};

export interface ReadReceiptRequest {
  send: (channelId: string, throughSequence?: string) => Promise<MarkChannelReadView>;
  isCurrent?: () => boolean;
  onAcknowledged?: (result: MarkChannelReadView) => void | Promise<void>;
  onError?: (cause: unknown) => void;
}

/** One serial, monotonic read watermark per channel; rendering and visibility stay in the apps. */
export const createReadReceiptController = () => {
  const acknowledged = new Map<string, bigint>();
  const pending = new Map<string, { sequence: string | undefined }>();
  const running = new Map<string, Promise<void>>();
  let generation = 0;

  return {
    hasState: (channelId: string): boolean => acknowledged.has(channelId) || pending.has(channelId),
    acknowledgedThrough: (channelId: string): string | null =>
      acknowledged.get(channelId)?.toString() ?? null,
    clear: () => {
      generation += 1;
      acknowledged.clear();
      pending.clear();
      running.clear();
    },
    request: (
      channelId: string,
      throughSequence: string | undefined,
      options: ReadReceiptRequest
    ): Promise<void> => {
      const target = numericSequence(throughSequence);
      if (throughSequence !== undefined && target === null) return Promise.resolve();
      if (target !== null && target <= (acknowledged.get(channelId) ?? -1n))
        return Promise.resolve();
      const previous = pending.get(channelId);
      const previousSequence = numericSequence(previous?.sequence);
      if (
        !previous ||
        throughSequence === undefined ||
        (previous.sequence !== undefined && target !== null && target > (previousSequence ?? -1n))
      ) {
        pending.set(channelId, { sequence: throughSequence });
      }
      const existing = running.get(channelId);
      if (existing) return existing;
      const epoch = generation;
      const isCurrent = () => epoch === generation && (options.isCurrent?.() ?? true);
      // Start on the next microtask so even a synchronous adapter failure cannot
      // settle before the in-flight request has been registered.
      const request = Promise.resolve().then(async () => {
        try {
          while (isCurrent()) {
            const next = pending.get(channelId);
            if (!next) break;
            const before = acknowledged.get(channelId) ?? -1n;
            const result = await options.send(channelId, next.sequence);
            if (!isCurrent()) return;
            const confirmed = numericSequence(result.lastReadSequence);
            if (confirmed !== null)
              acknowledged.set(channelId, confirmed > before ? confirmed : before);
            const queued = pending.get(channelId);
            const queuedSequence = numericSequence(queued?.sequence);
            const requested = numericSequence(next.sequence);
            const accepted = requested === null || (confirmed !== null && confirmed >= requested);
            if (
              (queued === next && accepted) ||
              (confirmed !== null && queuedSequence !== null && queuedSequence <= confirmed)
            ) {
              pending.delete(channelId);
            }
            await options.onAcknowledged?.(result);
            // Retain a partial acknowledgement for retry, without spinning on a
            // server that cannot advance its watermark yet.
            if (!accepted) break;
          }
        } catch (cause) {
          if (isCurrent()) options.onError?.(cause);
        } finally {
          if (running.get(channelId) === request) running.delete(channelId);
        }
      });
      running.set(channelId, request);
      return request;
    },
  };
};
