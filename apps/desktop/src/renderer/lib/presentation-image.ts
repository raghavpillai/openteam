/** Raw provider URLs are data for our server; never renderer image destinations. */
export function presentationImageResource(source?: string): string | null {
  if (!source || source.length > 8192) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `/api/v0/presentation-image?${new URLSearchParams({ url: source })}`;
  } catch { return null; }
}

/** Retry only the image service's temporary admission response, in the original lease. */
export function createPresentationImageFetch(fetchImage = fetch, retryDelayMs = 1000) {
  return async (target: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> => {
    const signal = AbortSignal.any([init.signal, AbortSignal.timeout(25_000)]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetchImage(target, { ...init, signal, redirect: "error" });
      if (response.status !== 503 || response.headers.get("retry-after") !== "1" || attempt === 11) return response;
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(done, retryDelayMs);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  };
}
export const fetchPresentationImage = createPresentationImageFetch();
