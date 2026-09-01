const CANONICAL_ASSET_PATH = /^\/api\/v0\/assets\/[a-f0-9]{64}$/;

const sameOriginUrl = (source: string, apiBase: string): URL | null => {
  try {
    const url = new URL(source, apiBase);
    return url.origin === new URL(apiBase).origin ? url : null;
  } catch {
    return null;
  }
};

export const canonicalPublicAssetUrl = (source: string, apiBase: string): string | null => {
  const url = sameOriginUrl(source, apiBase);
  return url && CANONICAL_ASSET_PATH.test(url.pathname) ? url.toString() : null;
};

export const protectedResourceUrl = (source: string, apiBase: string): string | null => {
  const url = sameOriginUrl(source, apiBase);
  return url?.pathname.startsWith("/api/") ? url.toString() : null;
};
