import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const STREAM_FILE_THRESHOLD = 4 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export async function fileDigest(path: string): Promise<string> {
  const input = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await input.close();
  }
}

/** Caller owns the staged file and must rename it or remove it after validation. */
export async function stageFile(source: string, directory: string, mode = 0o600) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `.box-store-part-${randomUUID()}`);
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  let staged = false;
  try {
    input = await open(source, "r");
    output = await open(path, "wx", mode);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) throw new Error("box-store file write made no progress");
        offset += bytesWritten;
      }
    }
    await output.sync();
    await output.close();
    output = undefined;
    staged = true;
    return { path, sha256: hash.digest("hex"), size };
  } finally {
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    if (!staged) await rm(path, { force: true }).catch(() => undefined);
  }
}
