import { useEffect, useState } from "react";
import { authHeaders, clearAuthToken } from "../client/auth";
import { API_BASE } from "../client/http";
import { canonicalPublicAssetUrl, protectedResourceUrl } from "../lib/resource-url";

export const useAuthenticatedResource = (source: string | null): string | null => {
  const directAsset = source ? canonicalPublicAssetUrl(source, API_BASE) : null;
  const target = source && !directAsset ? protectedResourceUrl(source, API_BASE) : null;
  const [resolved, setResolved] = useState<string | null>(() =>
    target ? null : (directAsset ?? source)
  );

  useEffect(() => {
    if (directAsset) {
      setResolved(directAsset);
      return;
    }
    if (!source || !target) {
      setResolved(source);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const headers = authHeaders();
    const requestToken =
      new Headers(headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    setResolved(null);
    void fetch(target, { headers, signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) clearAuthToken(requestToken);
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
  }, [directAsset, source, target]);

  return directAsset ?? resolved;
};
