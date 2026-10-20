import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, platform, totalmem } from "node:os";
import type { SystemActivityView } from "@openteam/contracts";

export const usagePercent = (used: number, total: number): number | null =>
  Number.isFinite(used) && Number.isFinite(total) && total > 0
    ? Math.round(Math.min(100, Math.max(0, (used / total) * 100)) * 10) / 10
    : null;

type CpuTimes = { idle: number; total: number };
const cpuTimes = (): CpuTimes =>
  cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 }
  );

export const cpuPercent = (before: CpuTimes, after: CpuTimes) => {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  return idle < 0 || idle > total ? null : usagePercent(total - idle, total);
};

export function linuxMemoryPercent(meminfo: string): number | null {
  const value = (key: string) =>
    Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"))?.[1]);
  const total = value("MemTotal");
  // MemFree alone counts reclaimable page cache as used and overstates memory pressure.
  return usagePercent(total - value("MemAvailable"), total);
}

async function memoryPercent() {
  if (platform() === "linux") {
    return linuxMemoryPercent(await readFile("/proc/meminfo", "utf8"));
  }
  return usagePercent(totalmem() - freemem(), totalmem());
}

async function diskPercent() {
  // The production asset volume shares the Docker data disk. Do not scan files.
  const disk = await statfs(process.env.OPENTEAM_ASSET_ROOT || process.cwd());
  return usagePercent(disk.blocks - disk.bfree, disk.blocks);
}

/** One short sample shared by concurrent viewers, with no background collector. */
export function createSystemActivityReader(
  sample = async (): Promise<SystemActivityView> => {
    const before = cpuTimes();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cpu = cpuPercent(before, cpuTimes());
    const [memory, disk] = await Promise.all([
      memoryPercent().catch(() => null),
      diskPercent().catch(() => null),
    ]);
    return {
      sampledAt: new Date().toISOString(),
      cpuPercent: cpu,
      memoryPercent: memory,
      diskPercent: disk,
    };
  },
  now = Date.now
) {
  let pending: Promise<SystemActivityView> | undefined;
  let cached: SystemActivityView | undefined;
  let sampledAt = 0;
  return (): Promise<SystemActivityView> => {
    if (cached && now() - sampledAt < 1_000) return Promise.resolve(cached);
    if (!pending) {
      pending = sample()
        .then((value) => {
          cached = value;
          sampledAt = now();
          return value;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}

export const systemActivity = createSystemActivityReader();
