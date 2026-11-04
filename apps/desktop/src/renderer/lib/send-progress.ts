import type { DurableSendRecord } from "@openteam/product-core/durable-delivery";

export const SEND_PROGRESS_DELAY_MS = 2_000;

/** A single indicator follows the newest pending message and the oldest active attempt. */
type SendProgressRecord = Pick<
  DurableSendRecord,
  "nonce" | "phase" | "createdAtMs" | "dispatchStartedAtMs"
>;

export function sendProgressOwner(deliveries: readonly SendProgressRecord[]) {
  let owner: SendProgressRecord | null = null;
  let sinceMs = Infinity;
  for (const delivery of deliveries) {
    if (delivery.phase !== "dispatching" || delivery.dispatchStartedAtMs === null) continue;
    sinceMs = Math.min(sinceMs, delivery.dispatchStartedAtMs);
    if (!owner || delivery.createdAtMs >= owner.createdAtMs) owner = delivery;
  }
  return owner ? { nonce: owner.nonce, sinceMs } : null;
}

export function sendProgressRevealDelay(sinceMs: number, mountedAtMs: number) {
  return Math.max(0, sinceMs + SEND_PROGRESS_DELAY_MS - mountedAtMs);
}

/** Reveal retry progress only after two completed failed submissions. */
export function sendRetryProgressVisible(delivery: Pick<DurableSendRecord, "phase" | "attemptCount"> | null) {
  if (!delivery || delivery.phase === "failed" || delivery.phase === "accepted-awaiting-echo") return false;
  const failures = delivery.attemptCount - (delivery.phase === "dispatching" ? 1 : 0);
  return failures >= 2;
}
