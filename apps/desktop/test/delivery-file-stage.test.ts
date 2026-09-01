import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discardDeliveryFiles,
  readDeliveryFile,
  stageDeliveryFile,
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
    const root = await mkdtemp(join(tmpdir(), "openbot-delivery-stage-"));
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
    const root = await mkdtemp(join(tmpdir(), "openbot-delivery-stage-"));
    temporaryDirectories.push(root);
    await expect(
      stageDeliveryFile(root, { stagingId: "../outside", bytes: new Uint8Array([1]) })
    ).rejects.toThrow("staging ID");
    await expect(
      stageDeliveryFile(root, { stagingId: "stage-empty-123", bytes: new Uint8Array() })
    ).rejects.toThrow("size");
  });
});
