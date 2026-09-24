import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore } from "../src/agent-data";

test("initialization repairs group traversal without exposing private state or resetting shared modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-access-"));
  const bot = { id: "access-fixture", status: "active", name: "Access fixture", avatarPath: null };
  const tx = { $executeRaw: async () => 0, bot: { findUnique: async () => bot } };
  const db = { $transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
  const store = new AgentDataStore(db as never, { root, workspaceRoot: root });
  const mode = async (path: string) => (await stat(path)).mode & 0o777;
  try {
    await chmod(root, 0o700);
    await store.ensureRuntimeDirectories();
    expect(await mode(root)).toBe(0o710);
    expect(await mode(join(root, "settings.json"))).toBe(0o600);
    expect(await mode(join(root, "connector-secrets"))).toBe(0o700);
    expect(await readFile(join(root, "managed-skills/routines/SKILL.md"), "utf8")).toContain("CRON_TZ=");
    await chmod(join(root, "settings.json"), 0o660);
    await store.ensureRuntimeDirectories();
    expect(await mode(join(root, "settings.json"))).toBe(0o600);
    await store.writeRootSettings({});
    expect(await mode(join(root, "settings.json"))).toBe(0o600);
    await chmod(root, 0o770);
    await store.initializeBot(bot.id);
    expect(await mode(root)).toBe(0o770);
    expect(JSON.parse(await readFile(join(root, "agents", bot.id, "profile.json"), "utf8")).name).toBe(bot.name);
    await chmod(root, 0o700);
    await store.initializeBot(bot.id);
    expect(await mode(root)).toBe(0o710);
    expect(await mode(join(root, "settings.json"))).toBe(0o600);
    expect(await mode(join(root, "connector-secrets"))).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid active-agent selections leave the previous selection unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-selection-"));
  const tx = { $executeRaw: async () => 0 };
  const db = { $transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
  const store = new AgentDataStore(db as never, { root, workspaceRoot: root });
  try {
    await store.writeActiveAgentId("existing-bot");
    for (const id of ["", ".", "..", "../invalid", "a/b", "a\\b", "bad\0id"]) {
      await expect(store.writeActiveAgentId(id)).rejects.toMatchObject({ status: 400, code: "invalid_active_agent" });
      expect(await store.loadActiveAgentId()).toBe("existing-bot");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
