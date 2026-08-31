import { useEffect, useState } from "react";
import { authHeaders, clearAuthToken } from "../client/auth";
import { API_BASE } from "../client/http";

const protectedUrl = (source: string): string | null => {
  try {
    const url = new URL(source, API_BASE);
    const api = new URL(API_BASE);
    return url.origin === api.origin && url.pathname.startsWith("/api/") ? url.toString() : null;
  } catch {
    return null;
  }
};

export const useAuthenticatedResource = (source: string | null): string | null => {
  const target = source ? protectedUrl(source) : null;
  const [resolved, setResolved] = useState<string | null>(() => (target ? null : source));

  useEffect(() => {
    if (!source || !target) {
      setResolved(source);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setResolved(null);
    void fetch(target, { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) clearAuthToken();
        if (!response.ok) throw new Error(`Protected resource failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResolved(null);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, target]);

  return resolved;
};
