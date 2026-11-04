import type { DurableSendRecord } from "@openteam/product-core/durable-delivery";

/** Keep a bubble mounted across safe retries, nonce rotation and transcript echoes. */
export function retainOutgoingMessageKey(
  { renderKey, delivery }: { renderKey: string; delivery: DurableSendRecord | null },
  aliases: Map<string, string>
): string {
  const nonces = delivery ? [...delivery.priorNonces, delivery.nonce] : [];
  const keys = [...nonces.map((nonce) => `optimistic:${nonce}`), renderKey];
  const stable = keys.map((key) => aliases.get(key)).find(Boolean) ?? keys[0]!;
  for (const key of keys) aliases.set(key, stable);
  return stable;
}
