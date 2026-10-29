import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROCESS_NOTICE_TYPE = "openteam-stopped-processes";
/** Every Shell command's processes carry their shell id, so programs it leaves running can be traced back to it. */
export const SHELL_ID_VARIABLE = "OPENTEAM_SHELL_ID";

const MAX_LISTED = 5;
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "nohup", "setsid"]);
const MAX_COMMAND_CHARS = 160;

export interface StoppedProcess {
  shellId: string;
  command: string;
  programs: string[];
  pid: number;
  startTime: string;
}

type Ledger = Record<string, StoppedProcess[]>;

const key = (entry: Pick<StoppedProcess, "pid" | "startTime">) => `${entry.pid}:${entry.startTime}`;

async function processStat(procRoot: string, pid: number) {
  const text = await readFile(join(procRoot, String(pid), "stat"), "utf8").catch(() => null);
  const close = text?.lastIndexOf(")") ?? -1;
  if (!text || close < 0) return null;
  const fields = text.slice(close + 2).split(" ");
  // Fields after the name start at the state (field 3); the start time is field 22.
  return { comm: text.slice(text.indexOf("(") + 1, close), state: fields[0], ppid: Number(fields[1]), startTime: fields[19] ?? "" };
}

/** The command as the bot typed it (secrets already redacted), from its output file's header. */
async function commandLine(outputPath: string): Promise<string | null> {
  const file = await open(outputPath, "r").catch(() => null);
  if (!file) return null;
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    const line = head.subarray(0, bytesRead).toString("utf8").split("\n").find((entry) => entry.startsWith("command: "));
    const value = line ? JSON.parse(line.slice("command: ".length)) : null;
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/**
 * Programs bots left running, by bot: processes that outlived the Shell command that started them
 * (`nohup … &`, daemons) and Shell commands sent to the background. A restart stops them all.
 */
export async function leftRunningProcesses(terminalDir: string, procRoot = "/proc"): Promise<Ledger> {
  const found = new Map<string, Array<{ pid: number; ppid: number; comm: string; startTime: string }>>();
  const pids = (await readdir(procRoot).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name));
  for (const name of pids.sort((a, b) => Number(a) - Number(b))) {
    const environment = await readFile(join(procRoot, name, "environ"), "utf8").catch(() => "");
    const shellId = environment.split("\0").find((entry) => entry.startsWith(`${SHELL_ID_VARIABLE}=`))?.slice(SHELL_ID_VARIABLE.length + 1);
    if (!shellId || !/^\d+$/.test(shellId)) continue;
    const stat = await processStat(procRoot, Number(name));
    if (!stat || stat.state === "Z") continue;
    found.set(shellId, [...(found.get(shellId) ?? []), { pid: Number(name), ...stat }]);
  }
  const ledger: Ledger = {};
  for (const [shellId, processes] of found) {
    const receipt = await readFile(join(terminalDir, `${shellId}.log.job.json`), "utf8")
      .then((text) => JSON.parse(text) as { scope?: unknown; title?: unknown; outcome?: unknown; background?: unknown }, () => null);
    // A foreground command still running belongs to the turn the restart cuts off, not to work left running.
    if (!(receipt?.outcome || receipt?.background === true) || typeof receipt.scope !== "string" || !receipt.scope) continue;
    // Name the programs, not the shells around them: the top-most non-shell process of each tree.
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const program = (entry: { comm: string }) => !SHELLS.has(entry.comm);
    const roots = processes.filter((entry) => {
      if (!program(entry)) return false;
      for (let parent = byPid.get(entry.ppid); parent; parent = byPid.get(parent.ppid)) if (program(parent)) return false;
      return true;
    });
    if (!roots.length) roots.push(...processes.filter(({ ppid }) => !byPid.has(ppid)));
    const command = ((await commandLine(join(terminalDir, `${shellId}.log`))) ?? String(receipt.title ?? "")).replace(/\s+/g, " ").trim();
    (ledger[receipt.scope] ??= []).push({
      shellId,
      command: command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS - 1)}…` : command,
      programs: [...new Set(roots.map(({ comm }) => comm))],
      pid: roots[0]!.pid,
      startTime: roots[0]!.startTime,
    });
  }
  return ledger;
}

export function processNotice(entries: readonly StoppedProcess[]): string | null {
  if (!entries.length) return null;
  const lines = entries.slice(0, MAX_LISTED).map(({ command, programs }) => `- \`${command}\`${programs.length ? ` (${programs.join(", ")})` : ""}`);
  if (entries.length > MAX_LISTED) lines.push(`- and ${entries.length - MAX_LISTED} more`);
  return `<system_reminder>\nThe computer restarted, which stopped programs your earlier Shell commands had left running:\n${lines.join("\n")}\nIf you still need them, start them again.\n</system_reminder>`;
}

/** At shutdown, remember what each bot left running; the bot hears once, on its next turn. */
export class ProcessNotice {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly terminalDir: string,
    private readonly ledgerPath: string,
    private readonly procRoot = "/proc"
  ) {}

  private async read(): Promise<Ledger> {
    const saved = await readFile(this.ledgerPath, "utf8").then((text) => JSON.parse(text), () => null);
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }

  private async write(ledger: Ledger) {
    const temporary = `${this.ledgerPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 });
    await rename(temporary, this.ledgerPath);
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Keeps what earlier stops recorded for bots that haven't had a turn since. */
  record(): Promise<void> {
    return this.serial(async () => {
      const found = await leftRunningProcesses(this.terminalDir, this.procRoot);
      if (!Object.keys(found).length) return;
      const ledger = await this.read();
      for (const [botId, entries] of Object.entries(found)) {
        const known = new Set((ledger[botId] ??= []).map(key));
        ledger[botId].push(...entries.filter((entry) => !known.has(key(entry))));
      }
      await this.write(ledger);
    });
  }

  /** The reminder this bot still has to see. Programs that are somehow still running are dropped. */
  claim(botId: string): Promise<{ keys: string[]; content: string } | null> {
    return this.serial(async () => {
      const entries = (await this.read())[botId];
      if (!Array.isArray(entries) || !entries.length) return null;
      const stopped: StoppedProcess[] = [];
      for (const entry of entries) {
        if ((await processStat(this.procRoot, entry.pid))?.startTime !== entry.startTime) stopped.push(entry);
      }
      const content = processNotice(stopped);
      if (content) return { keys: entries.map(key), content };
      await this.forget(botId, entries.map(key));
      return null;
    });
  }

  commit(botId: string, keys: readonly string[]): Promise<void> {
    return this.serial(() => this.forget(botId, keys));
  }

  private async forget(botId: string, keys: readonly string[]) {
    const ledger = await this.read();
    const done = new Set(keys);
    const remaining = (ledger[botId] ?? []).filter((entry) => !done.has(key(entry)));
    if (remaining.length) ledger[botId] = remaining;
    else delete ledger[botId];
    await this.write(ledger);
  }
}
