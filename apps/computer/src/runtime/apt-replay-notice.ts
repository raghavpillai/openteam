import { readFile, writeFile } from "node:fs/promises";
import { aptPaths, readPackageSnapshot, readReplayStatus, runCommand, type AptPaths, type CommandRunner } from "../apt-packages";

export const APT_REPLAY_NOTICE_TYPE = "openteam-apt-replay";

export const aptReplayReminder = (failed: readonly string[], log: string) =>
  `<system_reminder>\nThe computer restarted, and these apt packages installed on it earlier could not be reinstalled: ${failed.join(", ")}. Commands that need them fail until they are installed again with sudo apt-get install. The details are in ${log}.\n</system_reminder>`;

/**
 * After a startup replay that left recorded apt packages uninstalled, each bot hears once which
 * ones, on its next turn. Packages installed again since then are left out.
 */
export class AptReplayNotice {
  private told: { episode: string; bots: Set<string> } | null = null;

  constructor(
    private readonly ledgerPath?: string,
    private readonly paths: AptPaths = aptPaths(),
    private readonly run: CommandRunner = runCommand
  ) {}

  private async ledger(episode: string) {
    if (this.told?.episode !== episode) {
      const saved = this.ledgerPath ? await readFile(this.ledgerPath, "utf8").then((text) => JSON.parse(text), () => null) : null;
      this.told = { episode, bots: new Set(saved?.episode === episode && Array.isArray(saved.told) ? saved.told : []) };
    }
    return this.told;
  }

  /** The reminder this bot still has to see, if the last replay left packages missing. */
  async claim(botId: string): Promise<{ episode: string; content: string } | null> {
    const status = await readReplayStatus(this.paths);
    if (status?.state !== "done" || !status.failed.length || (await this.ledger(status.id)).bots.has(botId)) return null;
    const { installed } = await readPackageSnapshot(this.run);
    const failed = status.failed.filter((name) => !(name in installed));
    return failed.length ? { episode: status.id, content: aptReplayReminder(failed, this.paths.log) } : null;
  }

  async commit(botId: string, episode: string): Promise<void> {
    const told = await this.ledger(episode);
    if (told.bots.has(botId)) return;
    told.bots.add(botId);
    if (this.ledgerPath)
      await writeFile(this.ledgerPath, JSON.stringify({ episode, told: [...told.bots] })).catch(() => console.warn("Apt replay notice ledger write failed"));
  }
}
