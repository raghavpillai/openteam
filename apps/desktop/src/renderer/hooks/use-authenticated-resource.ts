import { useEffect, useState } from "react";
import { authHeaders, clearAuthToken } from "../client/auth";
import { API_BASE } from "../client/http";
import { protectedResourceUrl } from "../lib/resource-url";

interface ResolvedResource {
  source: string;
  url: string;
  retentionKey: string | null;
}

export const useAuthenticatedResource = (
  source: string | null,
  { retainPreviousFor }: { retainPreviousFor?: string } = {}
): string | null => {
  const target = source ? protectedResourceUrl(source, API_BASE) : null;
  const retentionKey = target && retainPreviousFor ? `${API_BASE}:${retainPreviousFor}` : null;
  const [resolved, setResolved] = useState<ResolvedResource | null>(null);

  // Revoke the previous blob only after React has replaced it in the DOM.
  // A refresh may keep displaying it while the replacement is being fetched.
  useEffect(() => () => {
    if (resolved) URL.revokeObjectURL(resolved.url);
  }, [resolved]);

  useEffect(() => {
    if (!source || !target) {
      setResolved(null);
      return;
    }
    const controller = new AbortController();
    const headers = authHeaders();
    const requestToken =
      new Headers(headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    setResolved((previous) =>
      retentionKey && previous?.retentionKey === retentionKey ? previous : null
    );
    void fetch(target, { headers, signal: controller.signal, redirect: "error" })
      .then(async (response) => {
        if (response.status === 401) clearAuthToken(requestToken);
        if (!response.ok) throw new Error(`Protected resource failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        setResolved({ source, url: URL.createObjectURL(blob), retentionKey });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResolved(null);
      });
    return () => {
      controller.abort();
    };
  }, [source, target, retentionKey]);

  if (!target) return source;
  // Never expose a previous bot's frame while a new resource is loading.
  return resolved && (resolved.source === source ||
    (retentionKey !== null && resolved.retentionKey === retentionKey)) ? resolved.url : null;
};
