export type JsonObject = Record<string, unknown>;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<
    string,
    Set<(params: JsonObject, sessionId: string | undefined) => void>
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => void this.onMessage(event));
    socket.addEventListener("close", () => this.failPending(new Error("Browser CDP closed")));
    socket.addEventListener("error", () => this.failPending(new Error("Browser CDP failed")));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Browser CDP connection timed out")),
        2_000
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Browser CDP connection failed"));
        },
        { once: true }
      );
    });
    return new CdpConnection(socket);
  }

  call<T>(method: string, params: JsonObject = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = method === "Runtime.evaluate" ? 30_000 : 2_000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(
    method: string,
    handler: (params: JsonObject, sessionId: string | undefined) => void
  ): () => void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(method);
    };
  }

  close(): void {
    this.socket.close();
    this.failPending(new Error("Browser CDP disconnected"));
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const text =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : new TextDecoder().decode(event.data as ArrayBuffer);
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: JsonObject;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof message.method === "string") {
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params ?? {}, message.sessionId);
      }
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "Browser CDP error"));
    else pending.resolve(message.result);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
