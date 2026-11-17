import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ServerUpdates, serverUpdateRoute } from "../../../server/src/server-updates";
import { DesktopDownloadGate } from "../../src/main/update-download";
import type { UpdateQueueState } from "../../src/renderer/lib/update-queue";

type Fault = "503" | "malformed" | "hang" | "body-hang" | "lost-post";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check: () => unknown, message: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (check()) return;
    await pause(10);
  }
  throw new Error(`Timed out: ${message}`);
}

export class UpdateQueueHttpChaos {
  readonly directory = mkdtempSync(join(tmpdir(), "openteam-queue-http-chaos-"));
  readonly cacheDirectory = join(this.directory, "cache");
  readonly stateFile = join(this.cacheDirectory, "queue.json");
  readonly hostDirectory = join(this.directory, "host");
  version = "0.0.18";
  updates = new ServerUpdates(this.hostDirectory, this.version);
  http: ReturnType<typeof Bun.serve> | null = null;
  port = 0;
  authorized = true;
  autoDownload = true;
  acceptancePaused = false;
  private accept!: () => void;
  private finish!: () => void;
  readonly faults = new Map<string, Fault[]>();
  readonly gate = new DesktopDownloadGate();
  readonly metrics = {
    httpRequests: 0,
    injectedFaults: 0,
    abortedRequests: 0,
    postAttempts: 0,
    acceptedJobIds: new Set<string>(),
    nativeRequests: 0,
    nativeStatusReads: 0,
    nativeJobs: 0,
    queueProcessKills: 0,
    serverRestarts: 0,
  };
  native = {
    currentVersion: "0.0.18",
    latestVersion: "0.0.19",
    status: "available",
    progress: null,
    message: null,
  } as OpenTeamUpdateStatus;
  private children = new Set<ReturnType<typeof Bun.spawn>>();
  constructor() {
    mkdirSync(this.cacheDirectory, { recursive: true });
  }

  async start() {
    this.updates.heartbeat({});
    this.http = Bun.serve({
      hostname: "127.0.0.1",
      port: this.port,
      idleTimeout: 10,
      fetch: (request) => this.route(request),
    });
    this.port = this.http.port!;
  }

  private async hang(request: Request): Promise<Response> {
    return new Promise((resolve) => {
      const aborted = () => {
        this.metrics.abortedRequests++;
        resolve(new Response("aborted", { status: 503 }));
      };
      if (request.signal.aborted) aborted();
      else request.signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private async route(request: Request): Promise<Response> {
    this.metrics.httpRequests++;
    const path = new URL(request.url).pathname;
    const key = `${request.method} ${path}`;
    const fault = this.faults.get(key)?.shift();
    if (fault) {
      this.metrics.injectedFaults++;
      if (fault === "503") return new Response("Service unavailable", { status: 503 });
      if (fault === "malformed")
        return new Response("{", { headers: { "content-type": "application/json" } });
      if (fault === "hang") return this.hang(request);
      if (fault === "body-hang")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"releaseVersion":"'));
            },
            cancel: () => {
              this.metrics.abortedRequests++;
            },
          }),
          { headers: { "content-type": "application/json" } }
        );
    }
    if (!this.authorized || request.headers.get("authorization") !== "Bearer isolated-chaos-owner")
      return Response.json(
        { error: { code: "unauthorized", message: "Sign in again" } },
        { status: 401 }
      );
    try {
      if (path === "/api/v0/system/version")
        return Response.json({ releaseVersion: this.version, apiProtocolVersion: 2 });
      if (path === "/api/v0/system/busy-bots") return Response.json({ bots: [] });
      if (path === "/api/v0/system/update") {
        if (request.method === "POST") this.metrics.postAttempts++;
        const response = await serverUpdateRoute(request, this.updates, "isolated-owner-session");
        if (request.method === "POST") {
          const job = this.updates.heartbeat({}).request;
          if (job) this.metrics.acceptedJobIds.add(job.id);
        }
        if (fault === "lost-post") return this.hang(request);
        return response;
      }
      if (path === "/native/status" || path === "/native/check") {
        this.metrics.nativeStatusReads++;
        return Response.json(this.native);
      }
      if (path === "/native/download" && request.method === "POST") {
        this.metrics.nativeRequests++;
        const { targetVersion } = (await request.json()) as { targetVersion: string };
        await this.gate.run(targetVersion, this.native.latestVersion, async () => {
          this.metrics.nativeJobs++;
          if (this.acceptancePaused)
            await new Promise<void>((resolve) => {
              this.accept = resolve;
            });
          this.native = { ...this.native, status: "downloading", progress: 10 };
          if (!this.autoDownload)
            await new Promise<void>((resolve) => {
              this.finish = resolve;
            });
          this.native = { ...this.native, status: "downloaded", progress: 100 };
        });
        return Response.json(null);
      }
      return new Response("Isolated endpoint not found", { status: 404 });
    } catch (error) {
      const cause = error as { status?: number; message?: string; code?: string };
      return Response.json(
        {
          error: {
            code: cause.code ?? "chaos_error",
            message: cause.message ?? "Injected failure",
          },
        },
        { status: cause.status ?? 500 }
      );
    }
  }

  spawn(action: "start" | "resume" | "retry") {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dirname, "update-queue-chaos-child.ts"),
        `http://127.0.0.1:${this.port}`,
        this.stateFile,
        action,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.children.add(child);
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const done = (async () => {
      const code = await child.exited;
      const [stdout, stderr] = await Promise.all([output, errors]);
      this.children.delete(child);
      return {
        code,
        stdout,
        stderr,
        result:
          code === 0
            ? (JSON.parse(stdout.trim()) as {
                state: UpdateQueueState | null;
                storageFailures: number;
                publications: number;
              })
            : null,
      };
    })();
    return { child, done };
  }

  snapshot(): UpdateQueueState | null {
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      return null;
    }
  }
  async kill(worker: ReturnType<UpdateQueueHttpChaos["spawn"]>) {
    this.metrics.queueProcessKills++;
    worker.child.kill("SIGKILL");
    await worker.done;
  }
  async stop() {
    await this.http?.stop(true);
    this.http = null;
  }
  async restart() {
    await this.stop();
    this.updates = new ServerUpdates(this.hostDirectory, this.version);
    this.metrics.serverRestarts++;
    await this.start();
  }
  phase(phase: string) {
    const job = this.updates.heartbeat({}).request;
    if (!job) throw new Error("No host job");
    this.updates.heartbeat({
      requestId: job.id,
      status: "running",
      phase,
      message: `Injected host stage: ${phase}`,
    });
  }
  complete(version = "0.0.19") {
    const job = this.updates.heartbeat({}).request;
    if (!job) throw new Error("No host job");
    this.version = version;
    this.updates.heartbeat({
      requestId: job.id,
      status: "complete",
      phase: "complete",
      message: "Verified by isolated host",
    });
  }
  fail(message: string) {
    const job = this.updates.heartbeat({}).request;
    if (!job) throw new Error("No host job");
    this.updates.heartbeat({ requestId: job.id, status: "error", phase: "rolling-back", message });
  }
  releaseAcceptance() {
    this.acceptancePaused = false;
    this.accept();
  }
  finishDownload() {
    this.finish();
  }
  summary() {
    return { ...this.metrics, acceptedJobIds: this.metrics.acceptedJobIds.size };
  }
  async close() {
    for (const child of this.children) child.kill("SIGKILL");
    for (const child of this.children) await child.exited;
    await this.stop();
    chmodSync(this.directory, 0o700);
    chmodSync(this.cacheDirectory, 0o700);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
