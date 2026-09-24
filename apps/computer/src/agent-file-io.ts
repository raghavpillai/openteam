import { protectedAgentDataPath } from "@openteam/contracts/agent-file-access";
import { HOST_TRANSFER_MAX_BYTES } from "@openteam/contracts/service-protocol";
import { spawnAgentProcess as spawn, agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";
import { nodeBinary } from "./node-runtime";

// File operations run as the same unprivileged user as Shell. Checking access
// before doing privileged I/O would leave a symlink replacement race.
export const AGENT_FILE_IO_SCRIPT = `const protectedAgentDataPath = ${protectedAgentDataPath.toString()};\n` + String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const cancellation = new AbortController();
// A signal may arrive before pipeline installs its error listeners, or during sync.
// Keep stdin's cancellation error from exiting before the temporary file is removed.
process.stdin.on('error', () => {});
process.on('SIGTERM', () => { cancellation.abort(); process.stdin.destroy(new Error('File transfer cancelled')); });
(async () => {
 const [mode, target, limitText, integrity, policyText] = process.argv.slice(1); const limit = Number(limitText);
 if (mode === 'read') {
   const file = await fs.open(target, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NONBLOCK);
   try {
     if (policyText) {
       const policy = JSON.parse(policyText);
       // Darwin's /dev/fd entries are not symlinks to their backing pathname.
       // F_GETPATH resolves the already-open descriptor without reopening it.
       const openedPath = process.platform === 'darwin'
         ? require('node:child_process').execFileSync('python3', ['-c', 'import fcntl,os,sys;sys.stdout.buffer.write(fcntl.fcntl(3,50,bytes(1024)).split(bytes([0]),1)[0])'], {stdio:['ignore','pipe','pipe',file.fd]}).toString('utf8')
         : '/proc/self/fd/' + file.fd;
       const actual = await fs.realpath(openedPath);
       const within = root => {const part=path.relative(root,actual);return part==='' || (part!=='..' && !part.startsWith('..'+path.sep) && !path.isAbsolute(part));};
       if (policy.protectedRoot && within(policy.protectedRoot)) {
         if (protectedAgentDataPath(path.relative(policy.protectedRoot,actual).split(path.sep).join('/')))
           throw Error('Read is not allowed for protected agent-data path');
       }
       if (policy.allowedRoots) {
       const root=policy.allowedRoots.find(within);
       if (!root || policy.excludedRoots.some(within) || path.relative(root,actual).split(path.sep).some(part=>part.startsWith('.')))
         throw Error('Attachment source changed or contains private state');
       }
     }
     const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('Source must be a regular file within the transfer size limit');
     let size = 0;
     const counted = new Transform({ transform(bytes, _encoding, done) { size += bytes.length; done(size > limit ? Error('File exceeds transfer limit') : null, bytes); } });
     await pipeline(file.createReadStream({ autoClose: false }), counted, process.stdout, { signal: cancellation.signal });
   } finally { await file.close(); }
 } else {
   await fs.mkdir(path.dirname(target), {recursive:true});
   const temporary = path.join(path.dirname(target), '.openteam-transfer-' + crypto.randomUUID());
   try {
     const file = await fs.open(temporary, 'wx', 0o600); let size = 0;
     const digest = crypto.createHash('sha256');
     try {
       // Drain the final partial pipe chunk and verify the file before publishing it.
       const output = new Writable({ write(chunk, _encoding, done) {
         size += chunk.length;
         digest.update(chunk);
         if (size > limit) { done(Error('File exceeds transfer limit')); return; }
         (async () => {
           let offset = 0;
           while (offset < chunk.length) {
             const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, size - chunk.length + offset);
             if (!bytesWritten) throw Error('File write made no progress');
             offset += bytesWritten;
           }
         })().then(() => done(), done);
       } });
       await pipeline(process.stdin, output, { signal: cancellation.signal }); await file.sync();
       if ((await file.stat()).size !== size) throw Error('Incomplete file transfer');
       if (integrity === 'verify') {
         // A separate, bounded control pipe authenticates the end of the byte
         // stream before publication; an early pipe EOF must preserve the old file.
         let receipt = '';
         for await (const part of require('node:fs').createReadStream(null, { fd: 3, signal: cancellation.signal })) {
           receipt += part.toString('utf8');
           if (receipt.length > 256) throw Error('Invalid file transfer receipt');
         }
         const expected = JSON.parse(receipt);
         if (expected.bytes !== size || expected.sha256 !== digest.digest('hex'))
           throw Error('File transfer integrity check failed');
       }
     }
     finally { await file.close(); }
     cancellation.signal.throwIfAborted(); await fs.rename(temporary, target);
   } finally { await fs.rm(temporary, {force:true}); }
 }
})().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });`;

export function agentFileIO(mode: "read", path: string, signal?: AbortSignal, policy?: { protectedRoot: string }): Promise<Buffer>;
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
  data?: Buffer | { protectedRoot: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      nodeBinary(),
      ["-e", AGENT_FILE_IO_SCRIPT, mode, path, String(HOST_TRANSFER_MAX_BYTES), "", ...(mode === "read" && data ? [JSON.stringify(data)] : [])],
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
    child.stdin.end(mode === "write" ? data : undefined);
  });
}
