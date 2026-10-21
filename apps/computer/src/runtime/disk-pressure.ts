import { statfs } from "node:fs/promises";

const GIB = 1024 ** 3;
const HEARTBEAT_MS = 5 * 60_000;
// The reference host's thresholds, with recovery hysteresis.
const THRESHOLDS = {
  softAvailableBytes: 8 * GIB,
  softAvailableRatio: 0.15,
  hardAvailableBytes: 2 * GIB,
  hardAvailableRatio: 0.05,
  softRecoveryBytes: 10 * GIB,
  softRecoveryRatio: 0.2,
  hardRecoveryBytes: 3 * GIB,
  hardRecoveryRatio: 0.08,
};

export type DiskPressureLevel = "healthy" | "soft" | "hard";

export const DISK_PRESSURE_REMINDER =
  "<system_reminder>\nThe computer is almost out of disk space. Avoid disk-heavy work such as large downloads, installs, builds or Docker images. The next time you message the user, tell them once: name their few biggest files or folders with sizes from a quick read-only check, and offer to delete them. Never delete anything without their explicit yes.\n</system_reminder>";

export function classifyDiskPressure(
  snapshot: { availableBytes: number; totalBytes: number },
  previous: DiskPressureLevel = "healthy"
): DiskPressureLevel {
  if (snapshot.totalBytes <= 0) return "healthy";
  const ratio = snapshot.availableBytes / snapshot.totalBytes;
  const below = (bytes: number, share: number) => snapshot.availableBytes <= bytes || ratio <= share;
  if (below(THRESHOLDS.hardAvailableBytes, THRESHOLDS.hardAvailableRatio)) return "hard";
  if (previous === "hard" && below(THRESHOLDS.hardRecoveryBytes, THRESHOLDS.hardRecoveryRatio)) return "hard";
  if (below(THRESHOLDS.softAvailableBytes, THRESHOLDS.softAvailableRatio)) return "soft";
  if (previous === "soft" && below(THRESHOLDS.softRecoveryBytes, THRESHOLDS.softRecoveryRatio)) return "soft";
  return "healthy";
}

/** One low-disk episode lasts from leaving healthy until recovering; each bot hears about it once. */
export class DiskPressureMonitor {
  private level: DiskPressureLevel = "healthy";
  private episode = 0;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private readonly told = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly read = async (path: string) => {
      const stats = await statfs(path);
      return { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    },
    private readonly now = () => Date.now()
  ) {}

  private async refresh(): Promise<void> {
    if (this.now() - this.checkedAt < HEARTBEAT_MS) return;
    this.checkedAt = this.now();
    const snapshot = await this.read(this.root).catch(() => null);
    if (!snapshot) return;
    const next = classifyDiskPressure(snapshot, this.level);
    if (this.level === "healthy" && next !== "healthy") this.episode += 1;
    this.level = next;
  }

  /** The episode this bot still has to hear about, if the disk is low. */
  async claim(botId: string): Promise<number | null> {
    await this.refresh();
    return this.level !== "healthy" && this.told.get(botId) !== this.episode ? this.episode : null;
  }

  commit(botId: string, episode: number): void {
    this.told.set(botId, episode);
  }
}
