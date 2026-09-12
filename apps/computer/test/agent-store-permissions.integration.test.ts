import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BotAgentStore } from "../src/bot-agent-store";

// Run as the production supervisor (0:1000) in a disposable Linux container.
test.skipIf(
  process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 1000
)(
  "the server UID can remove shared agent files after legacy permissions are repaired",
  async () => {
    const root = await mkdtemp("/tmp/agent-permission-qa-");
    await chmod(root, 0o750);
    const store = new BotAgentStore(root);
    const id = "71000000-0000-4000-8000-000000000001";
    const directory = store.agentDirectory(id);
    try {
      await store.openForWake(id);
      await store.closeAgent(id);
      const file = join(directory, "memory", "saved.txt");
      await writeFile(file, "preserved fixture data");
      for (const path of [
        join(root, "agents"),
        directory,
        join(directory, "memory"),
        join(directory, "automations"),
      ]) {
        await chmod(path, 0o750);
      }
      await store.openForWake(id);
      await store.closeAgent(id);
      expect((await stat(directory)).uid).toBe(0);
      expect((await stat(directory)).mode & 0o777).toBe(0o770);
      const result = spawnSync(
        "bun",
        [
          "-e",
          'await require("node:fs/promises").rm(process.argv[1],{recursive:true});',
          directory,
        ],
        {
          uid: 1000,
          gid: 1000,
          encoding: "utf8",
        }
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(await stat(directory).catch(() => null)).toBeNull();
    } finally {
      await store.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  }
);
