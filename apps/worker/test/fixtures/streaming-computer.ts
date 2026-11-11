/** Match the real computer's NDJSON contract: accepting a turn exposes response headers
 * before model/tool work finishes. Otherwise a fixture's tool callback waits on the worker's
 * dispatch transaction while that transaction waits for the fixture to return its headers. */
export function streamingComputer(handler: (request: Request) => Promise<Response>) {
  return (request: Request): Response | Promise<Response> => {
    if (new URL(request.url).pathname !== "/v1/turns") return handler(request);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // The protocol permits blank keepalives; flush one without manufacturing an event.
        controller.enqueue(new TextEncoder().encode("\n"));
        void (async () => {
          const response = await handler(request);
          if (!response.ok || !response.body) throw new Error(`Computer fixture rejected turn: ${response.status}`);
          if (cancelled) { await response.body.cancel(); return; }
          reader = response.body.getReader();
          try {
            while (!cancelled) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (!cancelled) controller.enqueue(chunk.value);
            }
            if (!cancelled) controller.close();
          } finally { reader.releaseLock(); }
        })().catch(error => { if (!cancelled) controller.error(error); });
      },
      async cancel() { cancelled = true; await reader?.cancel(); },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  };
}
