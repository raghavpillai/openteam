import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotAgentStore } from "../src/bot-agent-store";

test("concurrent transcript refreshes during bot provisioning publish a consistent snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-projection-race-"));
  const store = new BotAgentStore(root);
  const agentId = crypto.randomUUID();
  try {
    await store.initializeAgent(agentId);
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => store.refreshDerivedProjections(agentId))
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(
      JSON.parse(await readFile(join(root, "transcript-publish", `${agentId}.json`), "utf8"))
    ).toMatchObject({ agentId, entryCount: 0, latestSeq: 0 });

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        await store.appendTranscriptEntry(agentId, `message-${index}`, {
          kind: "message",
          content: `New conversation message ${index}`,
        });
        await store.refreshDerivedProjections(agentId);
      })
    );
    const rows = await store.readTranscriptEntries(agentId);
    const publication = JSON.parse(
      await readFile(join(root, "transcript-publish", `${agentId}.json`), "utf8")
    );
    expect(publication.entryCount).toBe(rows.length);
    expect(publication.latestSeq).toBe(rows.at(-1)?.seq);
    const index = new Database(join(root, "search-index.db"), { readonly: true });
    try {
      expect(
        index.query("SELECT count(*) AS count FROM messages WHERE agent_id = ?").get(agentId)
      ).toEqual({ count: rows.length });
    } finally {
      index.close();
    }
    expect(
      (await readdir(join(root, "transcript-publish"))).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  } finally {
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
