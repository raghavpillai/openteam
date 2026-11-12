import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRef } from "@openteam/contracts";
import { AgentDataStore } from "../src";

const roots: string[] = [];

const fixture = async (activeAtCommit: boolean, bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0x5a)) => {
  const root = await mkdtemp(join(tmpdir(), "openteam-materialized-attachments-"));
  roots.push(root);
  const dataRoot = join(root, "agent-data");
  const assetRoot = join(root, "assets");
  await mkdir(assetRoot, { recursive: true });
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

  test("names a file that arrived without a name by its detected type", async () => {
    const { store, dataRoot, attachment, assetId } = await fixture(true);
    const paths = await store.materializeAttachments("bot-1", "nameless-message", [
      { ...attachment, fileName: "1089646", mimeType: "application/pdf", kind: "pdf" },
    ]);
    expect(paths).toEqual([join(dataRoot, "agents", "bot-1", "attachments", `${assetId}.pdf`)]);
  });

  test("materializes a verified empty upload without treating it as missing", async () => {
    const { store, dataRoot, attachment, assetId } = await fixture(true, Buffer.alloc(0));
    const paths = await store.materializeAttachments("bot-1", "empty-message", [attachment]);
    expect(paths).toEqual([join(dataRoot, "agents", "bot-1", "attachments", `${assetId}.data`)]);
    expect((await readFile(paths[0]!)).length).toBe(0);
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

});
