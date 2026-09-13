import { spawn } from "node:child_process";
import { HOST_TRANSFER_MAX_BYTES } from "@openteam/contracts/service-protocol";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";

// File operations run as the same unprivileged user as Shell. Checking access
// before doing privileged I/O would leave a symlink replacement race.
const SCRIPT = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const cancellation = new AbortController();
process.on('SIGTERM', () => { cancellation.abort(); process.stdin.destroy(new Error('File transfer cancelled')); });
(async () => {
 const [mode, target, limitText] = process.argv.slice(1); const limit = Number(limitText);
 if (mode === 'read') {
   const file = await fs.open(target, 'r');
   try { const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('Source must be a regular file of at most 256 MiB');
     let size = 0; for await (const bytes of file.createReadStream({ autoClose: false, signal: cancellation.signal })) { size += bytes.length; if (size > limit) throw Error('File exceeds transfer limit'); process.stdout.write(bytes); }
   } finally { await file.close(); }
 } else {
   await fs.mkdir(path.dirname(target), {recursive:true});
   const temporary = path.join(path.dirname(target), '.openteam-transfer-' + crypto.randomUUID());
   try {
     const file = await fs.open(temporary, 'wx', 0o600); let size = 0;
     try { for await (const chunk of process.stdin) { size += chunk.length; if (size > limit) throw Error('File exceeds transfer limit'); await file.writeFile(chunk); } await file.sync(); }
     finally { await file.close(); }
     cancellation.signal.throwIfAborted(); await fs.rename(temporary, target);
   } finally { await fs.rm(temporary, {force:true}); }
 }
})().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });`;

export function agentFileIO(mode: "read", path: string, signal?: AbortSignal): Promise<Buffer>;
export function agentFileIO(
  mode: "write",
  path: string,
  signal: AbortSignal | undefined,
  data: Buffer
): Promise<Buffer>;
export function agentFileIO(
  mode: "read" | "write",
  path: string,
  signal?: AbortSignal,
  data?: Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", SCRIPT, mode, path, String(HOST_TRANSFER_MAX_BYTES)],
      {
        ...agentProcessIdentity(),
        env: sanitizedAgentEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      }
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > HOST_TRANSFER_MAX_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 10) errors.push(chunk);
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code !== 0 || size > HOST_TRANSFER_MAX_BYTES)
        reject(new Error(Buffer.concat(errors).toString() || "File transfer failed"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(data);
  });
}
