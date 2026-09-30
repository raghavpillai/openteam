/** Bound pending provider body reads, not total generation time. SSE heartbeats
 * count as transport activity; this does not impose a reasoning deadline. */
export function providerIdleFetch(request: typeof fetch, idleMs: number): typeof fetch {
  if (idleMs === 0) return request;
  return (async (input, init) => {
    const upstream = new AbortController();
    const parent = init?.signal ?? (input instanceof globalThis.Request ? input.signal : undefined);
    const signal = parent ? AbortSignal.any([parent, upstream.signal]) : upstream.signal;
    const response = await request(input, { ...init, signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let closed = false;
    const release = (reason?: unknown) => {
      closed = true;
      upstream.abort(reason);
      void reader.cancel(reason).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const next = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) { onAbort(); return; }
            timer = setTimeout(() => reject(new Error("Provider response stream idle timeout")), idleMs);
            timer.unref?.();
            void reader.read().then(resolve, reject);
          });
          if (closed) return;
          if (next.done) { closed = true; reader.releaseLock(); output.close(); }
          else output.enqueue(next.value);
        } catch (error) {
          if (!closed) { output.error(error); release(error); }
        } finally {
          clearTimeout(timer);
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      },
      cancel(reason) { release(reason); },
    });
    const wrapped = new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: response.url }, redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  }) as typeof fetch;
}
