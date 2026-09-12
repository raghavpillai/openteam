import { formatPiModelRef, type ServerInferenceSettings, type Snapshot } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";

export const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";

export class RuntimeHealth {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly computerUrl: string,
    private readonly isQueueReady: () => boolean,
    private readonly runtimeProbeTimeoutMs: number,
    private readonly inferenceSettings?: () => Promise<ServerInferenceSettings>
  ) {}
  private runtimeCache: { expiresAt: number; value: Snapshot["runtime"] } | null = null;

  private runtimeInFlight: Promise<Snapshot["runtime"]> | null = null;

  async runtimeStatus(): Promise<Snapshot["runtime"]> {
    let computer: Snapshot["runtime"]["computer"] = "unavailable";
    let inference: Snapshot["runtime"]["inference"] = "unavailable";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        this.probeRuntimeStatus(controller.signal),
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
    return {
      server: computer === "ready" ? "ready" : "degraded",
      database: "ready",
      queue: this.isQueueReady() ? "ready" : "unavailable",
      computer,
      inference,
    };
  }

  private async probeRuntimeStatus(signal: AbortSignal): Promise<{
    computer: Snapshot["runtime"]["computer"];
    inference: Snapshot["runtime"]["inference"];
  }> {
    const configuredInference = await this.inferenceSettings?.();
    const healthUrl = new URL("/health", this.computerUrl);
    if (configuredInference) {
      healthUrl.searchParams.set("model", formatPiModelRef(configuredInference));
    }
    const response = await fetch(healthUrl, { signal });
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
