import { readFile, writeFile } from "node:fs/promises";
import { installsPaths, readPackageSnapshot, readReplayStatus, runCommand, type CommandRunner, type InstallsPaths, type ReplayStatus } from "../apt-packages";

export const INSTALL_NOTICE_TYPE = "openteam-installs";

/** What the last start couldn't bring back, leaving out packages installed again since. */
export function installNotice(status: ReplayStatus, installed: Record<string, string>, log: string): string | null {
  const failed = status.failed.filter(({ name }) => !(name in installed));
  const pending = status.pending.filter((name) => !(name in installed));
  const { python, node } = status.languages ?? {};
  const lines: string[] = [];
  if (failed.length)
    lines.push(
      `The computer restarted and could not reinstall these apt packages installed on it earlier: ${failed.map(({ name, reason }) => `${name} (${reason})`).join("; ")}. ` +
        `It won't try again until the computer's image changes. If they are still needed, install them again another way; otherwise run \`sudo openteam-installs forget ${failed.map(({ name }) => name).join(" ")}\` so they stop being tracked.`
    );
  if (pending.length)
    lines.push(`These apt packages installed earlier are not back yet, because the network or their apt source was unreachable at start: ${pending.join(", ")}. The computer tries again at its next start.`);
  if (python)
    lines.push(
      `The computer's Python changed from ${python.from} to ${python.to}, so pip packages and uv tools installed for ${python.from} were reinstalled for it${python.reinstalled.length ? `: ${python.reinstalled.join(", ")}` : ""}.` +
        (python.failed.length ? ` These could not be reinstalled: ${python.failed.join(", ")}.` : "")
    );
  if (node)
    lines.push(node.rebuilt
      ? `The computer's Node.js changed from ${node.from} to ${node.to}, so global npm packages in /usr/local were rebuilt for it.`
      : `The computer's Node.js changed from ${node.from} to ${node.to}, and rebuilding global npm packages in /usr/local failed; packages with native code need \`sudo npm rebuild -g\` or a reinstall.`);
  return lines.length ? `<system_reminder>\n${lines.join("\n")} The details are in ${log}; \`openteam-installs\` lists what the computer reinstalls.\n</system_reminder>` : null;
}

/**
 * After a start that couldn't bring back some installs, or rebuilt language packages, each bot
 * hears once, on its next turn.
 */
export class InstallNotice {
  private told: { episode: string; bots: Set<string> } | null = null;

  constructor(
    private readonly ledgerPath?: string,
    private readonly paths: InstallsPaths = installsPaths(),
    private readonly run: CommandRunner = runCommand
  ) {}

  private async ledger(episode: string) {
    if (this.told?.episode !== episode) {
      const saved = this.ledgerPath ? await readFile(this.ledgerPath, "utf8").then((text) => JSON.parse(text), () => null) : null;
      this.told = { episode, bots: new Set(saved?.episode === episode && Array.isArray(saved.told) ? saved.told : []) };
    }
    return this.told;
  }

  /** The reminder this bot still has to see, if the last start left something to say. */
  async claim(botId: string): Promise<{ episode: string; content: string } | null> {
    const status = await readReplayStatus(this.paths);
    if (status?.state !== "done" || (!status.failed.length && !status.pending.length && !status.languages)) return null;
    if ((await this.ledger(status.id)).bots.has(botId)) return null;
    const { installed } = await readPackageSnapshot(this.run);
    const content = installNotice(status, installed, this.paths.log);
    return content ? { episode: status.id, content } : null;
  }

  async commit(botId: string, episode: string): Promise<void> {
    const told = await this.ledger(episode);
    if (told.bots.has(botId)) return;
    told.bots.add(botId);
    if (this.ledgerPath)
      await writeFile(this.ledgerPath, JSON.stringify({ episode, told: [...told.bots] })).catch(() => console.warn("Install notice ledger write failed"));
  }
}
