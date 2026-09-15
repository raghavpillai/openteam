import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellCompletionInput } from "@openteam/contracts";
import type { ShellAwaitResponse } from "@openteam/contracts/service-protocol";
interface PendingHostShell {
  botId: string;
  channelId?: string;
  automationRunId?: string;
  machineId: string;
  shellId: string;
  outputPath: string;
  completion?: ShellCompletionInput;
}
/** Computer-side outbox survives desktop disconnects and runtime restarts. It
 * polls the existing host receipt without starting or killing another process. */
export class HostShellCompletions {
  private readonly timer: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(
    private readonly directory: string,
    private readonly pollHost: (job: PendingHostShell) => Promise<ShellAwaitResponse>,
    private readonly deliver: (completion: ShellCompletionInput) => Promise<void>
  ) {
    this.timer = setInterval(() => void this.flush().catch(() => {}), 2000);
    this.timer.unref();
  }
  dispose() {
    clearInterval(this.timer);
  }
  private async save(path: string, value: PendingHostShell) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async register(value: PendingHostShell) {
    const id = createHash("sha256")
      .update(`${value.botId}:${value.machineId}:${value.shellId}`)
      .digest("hex");
    await this.save(join(this.directory, `${id}.json`), value);
  }
  async flush() {
    if (this.polling) return;
    this.polling = true;
    try {
      const files = await readdir(this.directory).catch(() => []);
      for (let offset = 0; offset < files.length; offset += 16)
        await Promise.all(
          files
            .slice(offset, offset + 16)
            .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
            .map(async (file) => {
              const path = join(this.directory, file);
              try {
                const job = JSON.parse(await readFile(path, "utf8")) as PendingHostShell;
                if (!job.completion) {
                  const receipt = await this.pollHost(job);
                  if (!["completed", "failed"].includes(receipt.status)) return;
                  job.completion = {
                    id: file.slice(0, -5),
                    scope: job.botId,
                    channelId: job.channelId,
                    ...(job.automationRunId ? { automationRunId: job.automationRunId } : {}),
                    outputPath: receipt.output_path ?? job.outputPath,
                    exitCode: receipt.exit_code ?? null,
                    machineId: job.machineId,
                    hostShellId: job.shellId,
                    error: receipt.error,
                  };
                  await this.save(path, job);
                }
                await this.deliver(job.completion);
                await rm(path, { force: true });
              } catch {
                /* Offline hosts and delivery failures keep their durable receipts. */
              }
            })
        );
    } finally {
      this.polling = false;
    }
  }
}
