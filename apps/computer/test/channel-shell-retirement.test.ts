import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeToolExecutor } from "../src/native-tool-executor";

test("retiring a room stops its background commands without stopping members' other conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-room-shell-retirement-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({ agentDir: root, controlToken: "fixture" });
  const room = crypto.randomUUID();
  const otherRoom = crypto.randomUUID();
  const bots = [crypto.randomUUID(), crypto.randomUUID()];
  const jobs: Array<{ id: string; botId: string; channelId: string }> = [];
  const status = async (job: typeof jobs[number], wait = 0) =>
    (await executor.awaitShell({ shell_id: job.id, block_until_ms: wait }, undefined, job.botId)).details.status;
  try {
    for (const botId of bots) {
      for (const channelId of [room, otherRoom]) {
        const result = await executor.shell({ command: "sleep 20", block_until_ms: 0 }, root, undefined, undefined, botId, { channelId });
        jobs.push({ id: String(result.details?.shellId), botId, channelId });
      }
    }
    expect(executor.stopBackgroundShells(room)).toBe(2);
    for (const job of jobs) {
      expect(await status(job, job.channelId === room ? 3000 : 0)).toBe(job.channelId === room ? "completed" : "running");
    }
  } finally {
    for (const botId of bots) executor.stopBackgroundShells(botId);
    await Promise.all(jobs.map((job) => status(job, 5000).catch(() => {})));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
