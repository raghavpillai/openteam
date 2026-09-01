import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRef } from "@openbot/contracts";
import { AgentDataStore } from "../src";

const roots: string[] = [];

const fixture = async (activeAtCommit: boolean) => {
  const root = await mkdtemp(join(tmpdir(), "openbot-materialized-attachments-"));
  roots.push(root);
  const dataRoot = join(root, "agent-data");
  const assetRoot = join(root, "assets");
  await mkdir(assetRoot, { recursive: true });
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0x5a);
  const assetId = createHash("sha256").update(bytes).digest("hex");
  const source = join(assetRoot, `${assetId}.blob`);
  await writeFile(source, bytes);
  const events: string[] = [];
  let stagedBeforeTransaction = false;
  const prisma = {
    bot: {
      count: async () => {
        events.push("preflight");
        return 1;
      },
    },
    $transaction: async <T>(action: (tx: unknown) => Promise<T>): Promise<T> => {
      events.push("transaction-start");
      const stagingDirectory = join(dataRoot, ".attachment-staging");
      const staged = (await readdir(stagingDirectory)).filter((name) =>
        name.startsWith(".attachment-part-")
      );
      stagedBeforeTransaction =
        staged.length === 1 &&
        (await stat(join(stagingDirectory, staged[0] ?? "missing"))).size === bytes.byteLength;
      // If the final file still contains the original bytes after this write,
      // the large source copy and hash necessarily completed before the lock.
      await writeFile(source, "changed after staging");
      const tx = {
        $executeRaw: async () => {
          events.push("lock");
          return 1;
        },
        bot: {
          count: async () => {
            events.push("revalidate");
            return activeAtCommit ? 1 : 0;
          },
        },
      };
      const result = await action(tx);
      events.push("transaction-end");
      return result;
    },
  };
  const store = new AgentDataStore(prisma as never, {
    root: dataRoot,
    assetRoot,
    workspaceRoot: join(root, "workspace"),
  });
  const attachment: AssetRef = {
    assetId,
    fileName: "archive.DATA",
    mimeType: "application/octet-stream",
    byteSize: bytes.byteLength,
    kind: "file",
  };
  return {
    store,
    dataRoot,
    bytes,
    assetId,
    attachment,
    events,
    staged: () => stagedBeforeTransaction,
  };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent attachment materialization", () => {
  test("stages and verifies large bytes before the advisory transaction", async () => {
    const { store, dataRoot, bytes, assetId, attachment, events, staged } = await fixture(true);

    const paths = await store.materializeAttachments("bot-1", "message-1", [attachment]);

    expect(staged()).toBeTrue();
    expect(events).toEqual([
      "preflight",
      "transaction-start",
      "lock",
      "lock",
      "revalidate",
      "transaction-end",
    ]);
    expect(paths).toEqual([join(dataRoot, "agents", "bot-1", "attachments", `${assetId}.data`)]);
    expect(await readFile(paths[0] ?? "missing")).toEqual(bytes);
    expect(await readdir(join(dataRoot, ".attachment-staging"))).toEqual([]);
  });

  test("revalidates bot activity under the lock and removes rejected staging files", async () => {
    const { store, dataRoot, attachment, events, staged } = await fixture(false);

    expect(await store.materializeAttachments("bot-1", "message-1", [attachment])).toEqual([]);

    expect(staged()).toBeTrue();
    expect(events.at(-2)).toBe("revalidate");
    expect(events.at(-1)).toBe("transaction-end");
    expect(await readdir(join(dataRoot, ".attachment-staging"))).toEqual([]);
    expect(
      await stat(join(dataRoot, "agents", "bot-1", "attachments")).catch(() => null)
    ).toBeNull();
  });

  test("revalidates cached legacy paths and rescans after external changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-agent-attachment-cache-"));
    roots.push(root);
    const agentsRoot = join(root, "agents");
    const assetId = "a".repeat(64);
    const first = join(agentsRoot, "agent-a", "attachments", `${assetId}.png`);
    const second = join(agentsRoot, "agent-z", "attachments", `${assetId}.webp`);
    await Promise.all([
      mkdir(join(agentsRoot, "agent-a", "attachments"), { recursive: true }),
      mkdir(join(agentsRoot, "agent-z", "attachments"), { recursive: true }),
    ]);
    await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
    const store = new AgentDataStore({} as never, { root });
    const internals = store as unknown as {
      findAgentAttachmentPath: (candidateAssetId: string) => Promise<string | null>;
    };
    const findAgentAttachmentPath = internals.findAgentAttachmentPath.bind(store);
    let scans = 0;
    internals.findAgentAttachmentPath = async (candidateAssetId) => {
      scans += 1;
      return findAgentAttachmentPath(candidateAssetId);
    };

    expect(
      new Set(
        await Promise.all(Array.from({ length: 12 }, () => store.agentAttachmentPath(assetId)))
      )
    ).toEqual(new Set([await realpath(first)]));
    expect(scans).toBe(1);
    expect(await store.agentAttachmentPath(assetId)).toBe(await realpath(first));
    expect(scans).toBe(1);
    await rm(first);
    expect(await store.agentAttachmentPath(assetId)).toBe(await realpath(second));
    expect(scans).toBe(2);

    const addedId = "b".repeat(64);
    const added = join(agentsRoot, "agent-a", "attachments", `${addedId}.jpg`);
    expect(await store.agentAttachmentPath(addedId)).toBeNull();
    expect(scans).toBe(3);
    await writeFile(added, "added after the cache was warm");
    expect(await store.agentAttachmentPath(addedId)).toBe(await realpath(added));
    expect(scans).toBe(4);
  });
});
