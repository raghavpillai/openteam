import { readFile, rm, stat, statfs, writeFile } from "node:fs/promises";

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

/** A reminder is spent once a model step taken after it was saved, as the reference commits at that step's checkpoint. */
export function diskPressureReminderStepPersisted(messages: ReadonlyArray<{ role: string; customType?: string; stopReason?: string }>, customType = "openteam-disk-pressure"): boolean {
  const reminder = messages.findLastIndex((message) => message.role === "custom" && message.customType === customType);
  return reminder >= 0 && messages.slice(reminder + 1).some((message) => message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error");
}

type VolumeSnapshot = { device: string; availableBytes: number; totalBytes: number };

/**
 * One low-disk episode lasts from any watched volume leaving healthy until all recover; each bot
 * hears about it once. The episode and who heard survive a restart in a ledger, as in the reference.
 */
export class DiskPressureMonitor {
  private readonly levels = new Map<string, DiskPressureLevel>();
  private episode: string | null = null;
  private told = new Set<string>();
  private checkedAt = Number.NEGATIVE_INFINITY;
  private restored = false;

  constructor(
    private readonly roots: string[],
    private readonly ledgerPath?: string,
    private readonly read = async (path: string): Promise<VolumeSnapshot> => {
      const [stats, volume] = await Promise.all([stat(path), statfs(path)]);
      return { device: String(stats.dev), availableBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize };
    },
    private readonly now = () => Date.now()
  ) {}

  private async restore(): Promise<void> {
    if (this.restored || !this.ledgerPath) return;
    this.restored = true;
    const ledger = await readFile(this.ledgerPath, "utf8").then((text) => JSON.parse(text), () => null);
    if (ledger?.version !== 1 || typeof ledger.episode !== "string") return;
    this.episode = ledger.episode;
    this.told = new Set(Array.isArray(ledger.told) ? ledger.told.filter((id: unknown) => typeof id === "string") : []);
  }

  private async persist(): Promise<void> {
    if (!this.ledgerPath) return;
    if (this.episode === null) await rm(this.ledgerPath, { force: true });
    else await writeFile(this.ledgerPath, JSON.stringify({ version: 1, episode: this.episode, told: [...this.told] }));
  }

  private async refresh(): Promise<void> {
    await this.restore();
    if (this.now() - this.checkedAt < HEARTBEAT_MS) return;
    this.checkedAt = this.now();
    const snapshots = (await Promise.all(this.roots.map((root) => this.read(root).catch(() => null)))).filter((snapshot) => snapshot !== null);
    if (!snapshots.length) return;
    // Roots on one device count once.
    for (const snapshot of new Map(snapshots.map((snapshot) => [snapshot.device, snapshot])).values())
      this.levels.set(snapshot.device, classifyDiskPressure(snapshot, this.levels.get(snapshot.device)));
    const low = [...this.levels.values()].some((level) => level !== "healthy");
    if (low === (this.episode !== null)) return;
    this.episode = low ? crypto.randomUUID() : null;
    this.told.clear();
    await this.persist().catch(() => console.warn("Disk pressure ledger write failed"));
  }

  /** The episode this bot still has to hear about, if the disk is low. */
  async claim(botId: string): Promise<string | null> {
    await this.refresh();
    return this.episode !== null && !this.told.has(botId) ? this.episode : null;
  }

  async commit(botId: string, episode: string): Promise<void> {
    if (episode !== this.episode || this.told.has(botId)) return;
    this.told.add(botId);
    await this.persist().catch(() => console.warn("Disk pressure ledger write failed"));
  }
}
