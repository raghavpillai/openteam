const sameOriginUrl = (source: string, apiBase: string): URL | null => {
  try {
    const url = new URL(source, apiBase);
    return url.origin === new URL(apiBase).origin ? url : null;
  } catch {
    return null;
  }
};

export const protectedResourceUrl = (source: string, apiBase: string): string | null => {
  const url = sameOriginUrl(source, apiBase);
  return url?.pathname.startsWith("/api/") ? url.toString() : null;
};

/** Immutable asset aliases and download filenames identify the same blob bytes. */
export const resourceCacheUrl = (target: string): string => {
  const url = new URL(target);
  const asset = /^\/api\/(?:v0\/)?assets\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!asset) return target;
  url.pathname = `/api/v0/assets/${asset[1]}`;
  url.searchParams.delete("name");
  url.searchParams.delete("download");
  url.hash = "";
  return url.toString();
};
