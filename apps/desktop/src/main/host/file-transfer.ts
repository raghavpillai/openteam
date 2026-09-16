import { pipeline } from "node:stream/promises";
import { constants, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
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
        response.writeHead(200, {"content-type":"application/octet-stream","content-length":stat.size,"cache-control":"no-store"});
        await pipeline(createReadStream(permit.path,{fd:file.fd,autoClose:false}),response);
      } finally {
        await file.close();
      }
      return;
    }
    let bytes = 0;
    if ((await realpath(dirname(permit.path))) !== dirname(permit.path))
      throw new Error("The approved destination directory changed");
    const temporary = resolve(dirname(permit.path), `.openteam-transfer-${randomUUID()}`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > permit.bytes!) throw new Error("Transfer body exceeds declared size");
          await file.writeFile(chunk);
        }
        if (bytes !== permit.bytes) throw new Error("Incomplete file transfer");
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
