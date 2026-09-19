import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable, type Writable } from "node:stream";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";
import { AGENT_FILE_IO_SCRIPT } from "./agent-file-io";
import { nodeBinary } from "./node-runtime";

function fileProcess(mode: "read" | "write", path: string, signal?: AbortSignal) {
  const child = spawn(
    nodeBinary(),
    ["-e", AGENT_FILE_IO_SCRIPT, mode, path, String(Number.MAX_SAFE_INTEGER), "verify"],
    {
      ...agentProcessIdentity(),
      env: sanitizedAgentEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      signal,
    }
  );
  let errorText = "";
  child.stderr.on("data", (data: Buffer) => {
    if (errorText.length < 8192) errorText += data.toString();
  });
  child.stdin.on("error", () => {});
  const control = child.stdio[3] as Writable;
  control.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (code) =>
      processError
        ? reject(processError)
        : code === 0
          ? resolve()
          : reject(new Error(errorText || "File transfer interrupted"))
    );
  });
  // Install a rejection handler immediately; callers still await and receive the original failure.
  void done.catch(() => {});
  return { child, done, control };
}
export function agentReadStream(path: string, signal?: AbortSignal) {
  const { child, done, control } = fileProcess("read", path, signal);
  child.stdin.end();
  control.end();
  return { stream: child.stdout, done, cancel: () => child.kill() };
}
export async function agentWriteStream(
  path: string,
  stream: ReadableStream<Uint8Array> | Readable,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const { child, done, control } = fileProcess("write", path, signal);
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
    child.stdin.end();
    control.end(JSON.stringify({ bytes, sha256: hash.digest("hex") }));
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
