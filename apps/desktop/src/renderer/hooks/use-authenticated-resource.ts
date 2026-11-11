import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  authHeaders,
  clearAuthToken,
  getAuthCredentialGeneration,
  subscribeAuthSnapshot,
} from "../client/auth";
import { API_BASE } from "../client/http";
import { type BlobResourceLease, createBlobResourceCache } from "../lib/blob-resource-cache";
import { protectedResourceUrl } from "../lib/resource-url";

const resources = createBlobResourceCache();
let credentialGeneration = getAuthCredentialGeneration();
const unsubscribeAuth = subscribeAuthSnapshot(() => {
  const next = getAuthCredentialGeneration();
  if (next !== credentialGeneration) {
    credentialGeneration = next;
    resources.clear();
  }
});
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribeAuth();
    resources.clear();
  });

interface ResolvedResource {
  generation: number;
  source: string;
  url: string;
  retentionKey: string | null;
  lease: BlobResourceLease;
}

export const useAuthenticatedResource = (
  source: string | null,
  {
    enabled = true,
    retainPreviousFor,
    onError,
  }: { enabled?: boolean; retainPreviousFor?: string; onError?: (cause: unknown) => void } = {}
): string | null => {
  const failureHandler = useRef(onError);
  failureHandler.current = onError;
  const generation = useSyncExternalStore(subscribeAuthSnapshot, getAuthCredentialGeneration);
  const target = source ? protectedResourceUrl(source, API_BASE) : null;
  const retentionKey =
    target && retainPreviousFor ? `${generation}:${API_BASE}:${retainPreviousFor}` : null;
  const [resolved, setResolved] = useState<ResolvedResource | null>(null);
  const leases = useRef(new Set<BlobResourceLease>());

  // Also release a result delivered between the last commit and unmount.
  useEffect(
    () => () => {
      for (const lease of leases.current) lease.release();
      leases.current.clear();
    },
    []
  );

  // Release the previous blob only after React has replaced it in the DOM.
  // A refresh may keep displaying it while the replacement is being fetched.
  useEffect(
    () => () => {
      if (resolved) {
        resolved.lease.release();
        leases.current.delete(resolved.lease);
      }
    },
    [resolved]
  );

  useEffect(() => {
    if (!enabled || !source || !target) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    let delivered = false;
    const reportFailure = failureHandler.current;
    const headers = authHeaders();
    const requestToken =
      new Headers(headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    setResolved((previous) =>
      retentionKey && previous?.retentionKey === retentionKey ? previous : null
    );
    const lease = resources.acquire(`${generation}:${target}`, async (signal) => {
      const response = await fetch(target, { headers, signal, redirect: "error" });
      if (response.status === 401) clearAuthToken(requestToken);
      if (!response.ok) throw new Error(`Protected resource failed (${response.status})`);
      return response.blob();
    });
    leases.current.add(lease);
    void lease.ready
      .then((url) => {
        if (cancelled) return;
        delivered = true;
        setResolved({ generation, source, url, retentionKey, lease });
      })
      .catch((cause) => {
        if (!cancelled) {
          setResolved(null);
          reportFailure?.(cause);
        }
      });
    return () => {
      cancelled = true;
      if (!delivered) {
        lease.release();
        leases.current.delete(lease);
      }
    };
  }, [enabled, source, target, retentionKey, generation]);

  if (!enabled) return null;
  if (!target) return source;
  // Never expose a previous bot's frame while a new resource is loading.
  return resolved?.generation === generation &&
    (resolved.source === source ||
      (retentionKey !== null && resolved.retentionKey === retentionKey))
    ? resolved.url
    : null;
};
