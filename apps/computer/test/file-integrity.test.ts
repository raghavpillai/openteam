import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { AGENT_FILE_IO_SCRIPT } from "../src/agent-file-io";
import { nodeBinary } from "../src/node-runtime";

test("incomplete or altered pipe data cannot replace an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-integrity-"));
  const path = join(root, "destination");
  const original = "complete payload with a final partial chunk";
  const receipt = JSON.stringify({
    bytes: Buffer.byteLength(original),
    sha256: createHash("sha256").update(original).digest("hex"),
  });
  try {
    for (const payload of [
      original.slice(0, -7),
      original.replace("complete", "modified"),
      original,
    ]) {
      await writeFile(path, "preserved");
      const child = spawn(
        nodeBinary(),
        ["-e", AGENT_FILE_IO_SCRIPT, "write", path, "1048576", "verify"],
        { stdio: ["pipe", "pipe", "pipe", "pipe"] }
      );
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stderr.resume();
      child.stdout.resume();
      child.stdin.end(payload);
      (child.stdio[3] as Writable).end(receipt);
      expect(await closed).toBe(payload === original ? 0 : 1);
      expect(await readFile(path, "utf8")).toBe(payload === original ? original : "preserved");
      expect(await readdir(root)).toEqual(["destination"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
