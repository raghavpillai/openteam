import { HOST_BRIDGE_PATHS } from "@openteam/contracts/service-protocol";

interface RelayRequest { id: string; method: string; path: string; headers: Record<string, string>; hasBody: boolean }
interface Enrollment { credential: string; connectionId: string; serverUrl: string }
interface Options {
  machineId: string;
  localUrl: string;
  localToken: string;
  getToken: () => Promise<string | null>;
  getIdentity: () => Promise<{ label: string; localToolPermission: "always" | "ask" | "never" }>;
  fetch?: typeof fetch;
  retryMs?: number;
}

/** A signed-in desktop opens outbound requests only. No public listening port is required. */
export class DesktopMachineEnrollment {
  private controller?: AbortController;
  private current?: Enrollment;
  private serverUrl?: string;
  private readonly fetcher: typeof fetch;
  private readonly active = new Map<string, AbortController>();
  private running?: Promise<void>;
  private readonly seen = new Set<string>();
  private connectionError: string | null = null;

  constructor(private readonly options: Options) { this.fetcher = options.fetch ?? fetch; }

  configure(serverUrl: string) {
    const url = new URL(serverUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid enrollment server URL");
    const normalized = url.href.replace(/\/$/, "");
    if (this.serverUrl === normalized && this.controller && !this.controller.signal.aborted) return;
    const stopping = this.stop();
    this.serverUrl = normalized;
    const controller = new AbortController();
    this.controller = controller;
    this.running = stopping.then(() => this.run(normalized, controller.signal)).catch(() => {});
  }

  async stop() {
    const running = this.running;
    const connection = this.current;
    this.current = undefined;
    this.serverUrl = undefined;
    this.connectionError = null;
    this.controller?.abort();
    for (const active of this.active.values()) active.abort();
    this.active.clear();
    if (connection) await this.channel(connection, "/disconnect", { method: "POST", signal: AbortSignal.timeout(2_000) }).catch(() => {});
    await running;
  }

  private headers(enrollment: Pick<Enrollment, "credential" | "connectionId">) {
    return { authorization: `Bearer ${enrollment.credential}`, "x-openteam-machine-id": this.options.machineId, "x-openteam-connection-id": enrollment.connectionId };
  }

  private channel(enrollment: Enrollment, path: string, init: RequestInit = {}) {
    return this.fetcher(`${enrollment.serverUrl}/api/v0/machines/channel${path}`, {
      ...init, headers: { ...this.headers(enrollment), ...Object.fromEntries(new Headers(init.headers)) }, redirect: "error",
    });
  }

  async review(value: unknown) {
    const enrollment = this.current;
    if (!enrollment) throw new Error("Connect this desktop to OpenTeam before reviewing local actions");
    const response = await this.channel(enrollment, "/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Auto Review service failed (${response.status})`);
    return response.json();
  }

  isConnected() { return !!this.current; }
  status() { return { connected: this.isConnected(), configured: !!this.serverUrl, error: this.connectionError }; }

  private async run(serverUrl: string, signal: AbortSignal) {
    while (!signal.aborted) {
      let enrollment: Enrollment | undefined;
      try {
        const token = await this.options.getToken();
        signal.throwIfAborted();
        const response = await this.fetcher(`${serverUrl}/api/v0/machines/enroll`, {
          method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ machineId: this.options.machineId, ...await this.options.getIdentity() }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "error",
        });
        if (!response.ok) throw new Error(response.status === 403 ? "This computer is disabled. Enable it below to reconnect." : response.status === 401 ? "Sign in again to connect this computer." : `Could not register this computer (${response.status}). Retrying automatically.`);
        const result = await response.json() as { machineId: string; credential: string };
        if (result.machineId !== this.options.machineId || typeof result.credential !== "string" || !result.credential) throw new Error("Invalid desktop enrollment");
        enrollment = { serverUrl, credential: result.credential, connectionId: "" };
        const connected = await this.channel(enrollment, "/connect", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        if (!connected.ok) throw new Error("Desktop connection unavailable");
        const connection = await connected.json() as { connectionId: string };
        if (typeof connection.connectionId !== "string" || !connection.connectionId) throw new Error("Invalid desktop connection");
        enrollment.connectionId = connection.connectionId;
        signal.throwIfAborted();
        this.current = enrollment;
        this.connectionError = null;
        this.seen.clear();
        while (!signal.aborted) {
          const response = await this.channel(enrollment, "/poll", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ active: [...this.active.keys()], ...await this.options.getIdentity() }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
          });
          if (!response.ok) throw new Error("Desktop channel disconnected");
          const batch = await response.json() as { requests: RelayRequest[]; cancelled: string[] };
          if (!Array.isArray(batch.requests) || batch.requests.length > 8 || !Array.isArray(batch.cancelled)) throw new Error("Invalid desktop request batch");
          signal.throwIfAborted();
          for (const id of batch.cancelled) this.active.get(id)?.abort();
          for (const request of batch.requests) {
            if (this.seen.has(request.id)) continue;
            this.seen.add(request.id);
            // Rotate a quiet channel before allowing its deduplication set to grow without bound.
            if (this.seen.size > 10_000) throw new Error("Renew desktop channel");
            const operation = new AbortController();
            this.active.set(request.id, operation);
            const connectedEnrollment = enrollment;
            void this.handle(enrollment, request, AbortSignal.any([signal, operation.signal])).catch(async () => {
              // A failed upload/download must release its caller promptly. Never replay
              // a local mutation whose outcome may already have been committed.
              await this.channel(connectedEnrollment, `/requests/${request.id}/failure`, {
                method: "POST", signal: AbortSignal.timeout(2_000),
              }).catch(() => {});
            }).finally(() => {
              if (this.active.get(request.id) === operation) this.active.delete(request.id);
            });
          }
        }
      } catch (error) {
        if (!signal.aborted) this.connectionError = error instanceof Error ? error.message : "Could not connect this computer. Retrying automatically.";
      }
      finally {
        if (this.current === enrollment) this.current = undefined;
        for (const active of this.active.values()) active.abort();
        this.active.clear();
        if (enrollment) await this.channel(enrollment, "/disconnect", { method: "POST", signal: AbortSignal.timeout(2_000) }).catch(() => {});
      }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, this.options.retryMs ?? 5_000);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }

  private async handle(enrollment: Enrollment, operation: RelayRequest, signal: AbortSignal) {
    const allowed = Object.values(HOST_BRIDGE_PATHS).some(path => path === operation.path) || /^\/v1\/file-transfer\/[\da-f-]+$/i.test(operation.path);
    if (!allowed || !["GET", "POST", "PUT"].includes(operation.method) || !/^[\da-f-]{36}$/i.test(operation.id)) throw new Error("Invalid desktop operation");
    let body: ReadableStream<Uint8Array> | null = null;
    if (operation.hasBody) {
      const source = await this.channel(enrollment, `/requests/${operation.id}/body`, { signal });
      if (!source.ok) throw new Error("Desktop operation expired");
      body = source.body;
    }
    let response: Response;
    try {
      const headers = new Headers({ authorization: `Bearer ${this.options.localToken}` });
      for (const key of ["content-type", "content-length"]) if (typeof operation.headers[key] === "string") headers.set(key, operation.headers[key]!);
      response = await this.fetcher(`${this.options.localUrl}${operation.path}`, {
        method: operation.method, headers, body, signal, redirect: "error", duplex: "half",
      } as RequestInit);
    } catch {
      signal.throwIfAborted();
      response = Response.json({ error: "The local operation failed or disconnected; inspect its result before retrying" }, { status: 502 });
    }
    const headers = new Headers({ "x-openteam-status": String(response.status) });
    for (const key of ["content-type", "content-length"]) if (response.headers.has(key)) headers.set(key, response.headers.get(key)!);
    const receipt = await this.channel(enrollment, `/requests/${operation.id}/response`, {
      method: "POST", headers, body: response.body, signal, duplex: "half",
    } as RequestInit);
    if (!receipt.ok) throw new Error("The operation receipt was not accepted; do not replay it");
  }
}
