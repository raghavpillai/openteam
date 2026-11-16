import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discardDeliveryFiles,
  readDeliveryFile,
  stageDeliveryFile,
  sweepIncompleteDeliveryStages,
} from "../src/main/delivery-file-stage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("desktop durable attachment staging", () => {
  test("atomically retains bytes until the delivery controller discards them", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-delivery-stage-"));
    temporaryDirectories.push(root);
    await stageDeliveryFile(root, {
      stagingId: "stage-file-1234",
      bytes: new TextEncoder().encode("durable bytes"),
    });

    expect(new TextDecoder().decode(await readDeliveryFile(root, "stage-file-1234"))).toBe(
      "durable bytes"
    );
    await discardDeliveryFiles(root, ["stage-file-1234", "stage-file-1234"]);
    await expect(readDeliveryFile(root, "stage-file-1234")).rejects.toThrow();
  });

  test("rejects traversal and empty attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-delivery-stage-"));
    temporaryDirectories.push(root);
    await expect(
      stageDeliveryFile(root, { stagingId: "../outside", bytes: new Uint8Array([1]) })
    ).rejects.toThrow("staging ID");
    await expect(
      stageDeliveryFile(root, { stagingId: "stage-empty-123", bytes: new Uint8Array() })
    ).rejects.toThrow("size");
  });

  test("drops old half-written stages and keeps finished ones and fresh writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stage-sweep-"));
    try {
      await writeFile(join(directory, "aaaaaaaa-1111"), "finished");
      await writeFile(join(directory, "bbbbbbbb-2222.next"), "crashed mid-write");
      await writeFile(join(directory, "cccccccc-3333.next"), "being written now");
      const old = new Date(Date.now() - 60 * 60_000);
      await utimes(join(directory, "bbbbbbbb-2222.next"), old, old);
      expect(await sweepIncompleteDeliveryStages(directory)).toBe(1);
      expect((await readdir(directory)).sort()).toEqual(["aaaaaaaa-1111", "cccccccc-3333.next"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
