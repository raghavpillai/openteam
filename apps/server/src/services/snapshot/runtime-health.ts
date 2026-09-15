import { formatPiModelRef, type ServerInferenceSettings, type Snapshot } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";

export const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";

export class RuntimeHealth {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly computerUrl: string,
    private readonly isQueueReady: () => boolean | Promise<boolean>,
    private readonly runtimeProbeTimeoutMs: number,
    private readonly inferenceSettings?: () => Promise<ServerInferenceSettings>,
    private readonly transcriptionStatus?: () => Promise<"configured" | "missing" | "invalid">
  ) {}
  private runtimeCache: { expiresAt: number; value: Snapshot["runtime"] } | null = null;

  private runtimeInFlight: Promise<Snapshot["runtime"]> | null = null;
  private readonly pending = new Map<string, Promise<unknown>>();

  // A timeout ends the response, not necessarily the underlying database query.
  // Reuse unfinished operations so an outage cannot build an unbounded backlog.
  private once<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async runtimeStatus(): Promise<Snapshot["runtime"]> {
    const bounded = async <T>(operation: Promise<T>, fallback: T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          operation.catch(() => fallback),
          new Promise<T>((resolve) => {
            timer = setTimeout(() => resolve(fallback), this.runtimeProbeTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    };
    const databaseProbe = bounded(
      this.once("database", async () => {
        await this.prisma.$queryRaw`SELECT 1 FROM "Bot" LIMIT 0`;
        return "ready" as const;
      }),
      "unavailable" as "ready" | "unavailable"
    );
    const queueProbe = bounded(
      this.once("queue", async () => this.isQueueReady()),
      false
    );
    const transcriptionProbe = bounded(
      this.once("transcription", async () => this.transcriptionStatus?.() ?? "missing"),
      "invalid" as "configured" | "missing" | "invalid"
    );
    let computer: Snapshot["runtime"]["computer"] = "unavailable";
    let inference: Snapshot["runtime"]["inference"] = "unavailable";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        this.once("computer", () => this.probeRuntimeStatus(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Computer runtime health probe timed out"));
          }, this.runtimeProbeTimeoutMs);
          timer.unref?.();
        }),
      ]);
      computer = result.computer;
      inference = result.inference;
    } catch {
      // Snapshots remain usable while the runtime is down.
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    const [database, queueReady, transcription] = await Promise.all([
      databaseProbe,
      queueProbe,
      transcriptionProbe,
    ]);
    return {
      server: computer === "ready" && database === "ready" && queueReady ? "ready" : "degraded",
      database,
      queue: queueReady ? "ready" : "unavailable",
      computer,
      inference,
      transcription,
    };
  }

  private async probeRuntimeStatus(signal: AbortSignal): Promise<{
    computer: Snapshot["runtime"]["computer"];
    inference: Snapshot["runtime"]["inference"];
  }> {
    const configuredInference = await this.inferenceSettings?.();
    const healthUrl = new URL("/health/authenticated", this.computerUrl);
    if (configuredInference) {
      healthUrl.searchParams.set("model", formatPiModelRef(configuredInference));
    }
    const response = await fetch(healthUrl, {
      signal,
      headers: {
        authorization: `Bearer ${process.env.OPENTEAM_CONTROL_TOKEN ?? "local-compose-only-change-me"}`,
      },
    });
    const body = (await response.json()) as {
      status?: string;
      inference?: { ready?: boolean; authenticated?: boolean };
    };
    const computer = response.ok && body.status === "ready" ? "ready" : "unavailable";
    const inference = body.inference?.ready
      ? body.inference.authenticated
        ? "ready"
        : "missing"
      : "unavailable";
    await this.prisma.computer.update({
      where: { id: COMPUTER_ID },
      data: {
        status: computer === "ready" ? "ready" : "unavailable",
        lastSeenAt: new Date(),
      },
    });
    return { computer, inference };
  }

  async runtimeStatusCached(): Promise<Snapshot["runtime"]> {
    if (this.runtimeCache && this.runtimeCache.expiresAt > Date.now()) {
      return this.runtimeCache.value;
    }
    if (this.runtimeInFlight) return this.runtimeInFlight;
    this.runtimeInFlight = this.runtimeStatus()
      .then((value) => {
        this.runtimeCache = { expiresAt: Date.now() + 2_000, value };
        return value;
      })
      .finally(() => {
        this.runtimeInFlight = null;
      });
    return this.runtimeInFlight;
  }
}
