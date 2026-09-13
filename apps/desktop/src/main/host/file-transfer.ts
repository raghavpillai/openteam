import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HOST_TRANSFER_MAX_BYTES,
  type HostTransferRequest,
} from "@openteam/contracts/service-protocol";

type Permit = { path: string; direction: "read" | "write"; bytes?: number; expires: number };

/** Capabilities are short lived, one use, and bound to the exact approved path. */
export class HostFileTransfers {
  private readonly permits = new Map<string, Permit>();

  async prepare(input: HostTransferRequest) {
    for (const [key, permit] of this.permits)
      if (permit.expires < Date.now()) this.permits.delete(key);
    if (this.permits.size >= 100) throw new Error("Too many pending file transfers");
    const requested = resolve(input.path);
    if (input.direction === "write") await mkdir(dirname(requested), { recursive: true });
    // Resolve symlinks before issuing a capability, so a later changed symlink
    // cannot redirect a previously approved transfer to a different location.
    const path =
      input.direction === "read"
        ? await realpath(requested)
        : resolve(await realpath(dirname(requested)), basename(requested));
    const transferId = randomUUID();
    this.permits.set(transferId, {
      path,
      direction: input.direction,
      bytes: input.bytes,
      expires: Date.now() + 600_000,
    });
    return { transferId, path };
  }

  async transfer(id: string, request: IncomingMessage, response: ServerResponse) {
    const permit = this.permits.get(id);
    this.permits.delete(id);
    if (!permit || permit.expires < Date.now())
      throw new Error("File transfer expired or already used");
    if (request.method !== (permit.direction === "read" ? "GET" : "PUT"))
      throw new Error("Wrong transfer direction");
    if (permit.direction === "read") {
      const file = await open(permit.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Only regular files can be copied");
        if (stat.size > HOST_TRANSFER_MAX_BYTES)
          throw new Error("File exceeds the 256 MiB transfer limit");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > HOST_TRANSFER_MAX_BYTES)
            throw new Error("File exceeds the 256 MiB transfer limit");
          chunks.push(Buffer.from(chunk));
        }
        const data = Buffer.concat(chunks);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": data.length,
          "cache-control": "no-store",
        });
        response.end(data);
      } finally {
        await file.close();
      }
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > HOST_TRANSFER_MAX_BYTES || bytes > permit.bytes!)
        throw new Error("Transfer body exceeds declared size");
      chunks.push(Buffer.from(chunk));
    }
    if (bytes !== permit.bytes) throw new Error("Incomplete file transfer");
    if ((await realpath(dirname(permit.path))) !== dirname(permit.path))
      throw new Error("The approved destination directory changed");
    const temporary = resolve(dirname(permit.path), `.openteam-transfer-${randomUUID()}`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(Buffer.concat(chunks));
        await file.sync();
      } finally {
        await file.close();
      }
      if (request.destroyed && !request.complete) throw new Error("File transfer cancelled");
      if ((await realpath(dirname(permit.path))) !== dirname(permit.path))
        throw new Error("The approved destination directory changed");
      await rename(temporary, permit.path);
    } finally {
      await rm(temporary, { force: true });
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ path: permit.path, bytes }));
  }
}
