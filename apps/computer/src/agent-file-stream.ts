import { createHash, randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawnAgentProcess as spawn, agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";
import { AGENT_FILE_IO_SCRIPT } from "./agent-file-io";
import { nodeBinary } from "./node-runtime";

type ReadPolicy = { protectedRoot: string } | { allowedRoots: string[]; excludedRoots: string[] };

/** Bun 1.3.8's node:net wrapper and Subprocess finalizer both close extra stdio pipes.
 * Use an unlinked inherited file instead; the parent owns its fd until child exit.
 * Write the bounded receipt positionally before stdin EOF so the child cannot
 * inspect an incomplete receipt, and its inherited read offset remains at zero. */
function integrityReceipt() {
  const path = join(tmpdir(), `openteam-transfer-receipt-${randomUUID()}`);
  const fd = openSync(path, "wx+", 0o600);
  try { unlinkSync(path); }
  catch (error) { closeSync(fd); throw error; }
  let closed = false;
  return {
    fd,
    commit(value: { bytes: number; sha256: string }) {
      // A helper can fail before the source reaches EOF. Its close handler
      // releases this descriptor, which may already belong to another file.
      if (closed) throw new Error("File transfer receipt is no longer active");
      const data = Buffer.from(JSON.stringify(value));
      for (let offset = 0; offset < data.length;) {
        const written = writeSync(fd, data, offset, data.length - offset, offset);
        if (!written) throw new Error("File transfer receipt write made no progress");
        offset += written;
      }
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}

function fileProcess(mode: "read" | "write", path: string, signal?: AbortSignal, policy?: ReadPolicy) {
  const receipt = mode === "write" ? integrityReceipt() : undefined;
  const stdio: ["pipe", "pipe", "pipe", ...number[]] = receipt ? ["pipe", "pipe", "pipe", receipt.fd] : ["pipe", "pipe", "pipe"];
  const child = (() => {
    try {
      // Node's overloads lose the known first three pipes when an inherited fd
      // is appended, although stdin/stdout/stderr are all explicitly "pipe".
      return spawn(
        nodeBinary(),
        ["-e", AGENT_FILE_IO_SCRIPT, mode, path, String(Number.MAX_SAFE_INTEGER), "verify", ...(policy ? [JSON.stringify(policy)] : [])],
        { ...agentProcessIdentity(), env: sanitizedAgentEnvironment(process.env), stdio, signal }
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      receipt?.close();
      throw error;
    }
  })();
  let errorText = "";
  child.stderr.on("data", (data: Buffer) => {
    if (errorText.length < 8192) errorText += data.toString();
  });
  child.stdin.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
      receipt?.close();
    });
    child.once("close", (code) => {
      receipt?.close();
      processError
        ? reject(processError)
        : code === 0
          ? resolve()
          : reject(new Error(errorText || "File transfer interrupted"));
    });
  });
  // Install a rejection handler immediately; callers still await and receive the original failure.
  void done.catch(() => {});
  return { child, done, receipt };
}
export function agentReadStream(path: string, signal?: AbortSignal, policy?: ReadPolicy) {
  const { child, done } = fileProcess("read", path, signal, policy);
  child.stdin.end();
  return { stream: child.stdout, done, cancel: () => child.kill() };
}
export async function agentWriteStream(
  path: string,
  stream: ReadableStream<Uint8Array> | Readable,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const { child, done, receipt } = fileProcess("write", path, signal);
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = stream instanceof Readable ? undefined : stream.getReader();
  const abort = () => {
    if (reader) void reader.cancel(signal?.reason).catch(() => {});
    else (stream as Readable).destroy(new Error("File transfer cancelled"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks = async function* () {
    if (reader) {
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          yield item.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock?.();
      }
    } else yield* stream as Readable;
  };
  try {
    // Keep pipe writes bounded and wait for each write before reading more bytes.
    for await (const chunk of chunks()) {
      signal?.throwIfAborted();
      for (let offset = 0; offset < chunk.length; offset += 65536) {
        const part = chunk.subarray(offset, offset + 65536);
        await new Promise<void>((resolve, reject) =>
          child.stdin.write(part, (error) => (error ? reject(error) : resolve()))
        );
        hash.update(part);
        bytes += part.length;
      }
    }
    signal?.throwIfAborted();
    receipt!.commit({ bytes, sha256: hash.digest("hex") });
    child.stdin.end();
    await done;
    return bytes;
  } catch (error) {
    if (stream instanceof Readable) stream.destroy();
    child.kill();
    try {
      await done;
    } catch (processError) {
      if (
        !signal?.aborted &&
        processError instanceof Error &&
        processError.message !== "File transfer interrupted"
      )
        throw processError;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
