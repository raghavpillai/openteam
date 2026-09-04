import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  HOST_INLINE_OUTPUT_MAX_BYTES,
  HOST_READ_MAX_BYTES,
  imageMimeTypeForPath,
} from "@openteam/contracts/service-protocol";
import type { HostJobPayload, HostReadInput, HostShellInput } from "./job-protocol";

export const MAX_READ_BYTES = HOST_READ_MAX_BYTES;
export const MAX_INLINE_BYTES = HOST_INLINE_OUTPUT_MAX_BYTES;
export const MAX_PDF_TEXT_BYTES = 10 * 1024 * 1024;
export const MAX_SHELL_LOG_BYTES = 64 * 1024 * 1024;
const SHELL_LOG_FOOTER_RESERVE_BYTES = 1_024;
export const MAX_ACTIVE_SHELL_JOBS = 2;
export const MAX_QUEUED_SHELL_JOBS = 8;
export const MAX_SHELL_RUNTIME_MS = 2 * 60 * 60 * 1_000;
export const SHELL_TERMINATION_GRACE_MS = 1_500;

type HostChildStopReason =
  | "cancelled"
  | "output_limit"
  | "output_stream_error"
  | "shutdown"
  | "spawn_error"
  | "timed_out";

type HostChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface CapacityWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Counts permits until the OS child exits, rather than until the IPC request returns.
 * This matters for block_until_ms=0: the caller gets `running` immediately, but the
 * process must continue to consume one of the two global shell slots.
 */
export class ShellCapacity {
  private active = 0;
  private readonly waiters: CapacityWaiter[] = [];

  constructor(
    private readonly maxActive = MAX_ACTIVE_SHELL_JOBS,
    private readonly maxQueued = MAX_QUEUED_SHELL_JOBS
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("Shell capacity must allow at least one active job");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Shell queue capacity must be non-negative");
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Host shell was cancelled"));
    if (this.active < this.maxActive) return Promise.resolve(this.grant());
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new Error(`Host shell queue is full (${this.maxQueued} waiting commands)`)
      );
    }
    return new Promise((resolveAcquire, reject) => {
      const waiter: CapacityWaiter = { resolve: resolveAcquire, reject, signal };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(new Error("Host shell was cancelled"));
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  cancelQueued(error = new Error("Host shell jobs are shutting down")) {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  snapshot() {
    return { active: this.active, queued: this.waiters.length };
  }

  private grant() {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain() {
    while (this.active < this.maxActive && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("Host shell was cancelled"));
        continue;
      }
      waiter.resolve(this.grant());
    }
  }
}

interface ActiveHostExecution {
  terminate: (reason: HostChildStopReason) => Promise<void>;
}

const shellCapacity = new ShellCapacity();
const activeHostExecutions = new Set<ActiveHostExecution>();

export const hostShellCapacitySnapshot = () => shellCapacity.snapshot();

const lineCount = (value: string) => {
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
};

/**
 * Produces Read-compatible numbered output without allocating an array or a numbered
 * copy of every line. A 10 MiB one-character-per-line file stays O(input + output)
 * instead of expanding into millions of strings and hundreds of MiB of temporary data.
 */
export const numberText = (
  raw: string,
  requestedOffset: unknown,
  requestedLimit: unknown
): { text: string; lines: number } => {
  const totalLines = lineCount(raw);
  const offset =
    typeof requestedOffset === "number" && Number.isInteger(requestedOffset)
      ? requestedOffset
      : undefined;
  const limit =
    typeof requestedLimit === "number" && Number.isInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : undefined;
  const unclampedStart =
    offset === undefined
      ? 0
      : offset < 0
        ? Math.max(0, totalLines + offset)
        : Math.max(0, offset - 1);
  const start = Math.min(totalLines, unclampedStart);
  const end = limit === undefined ? totalLines : Math.min(totalLines, start + limit);
  const output: string[] = [];
  let outputLength = 0;
  let lineStart = 0;
  let lineIndex = 0;
  let truncated = false;

  const appendLine = (contentStart: number, contentEnd: number) => {
    if (lineIndex < start || lineIndex >= end || truncated) return;
    if (output.length > 0) {
      if (outputLength >= MAX_INLINE_BYTES) {
        truncated = true;
        return;
      }
      output.push("\n");
      outputLength += 1;
    }
    const prefix = `${lineIndex + 1}: `;
    const remaining = MAX_INLINE_BYTES - outputLength;
    if (prefix.length >= remaining) {
      output.push(prefix.slice(0, Math.max(0, remaining)));
      outputLength = MAX_INLINE_BYTES;
      truncated = true;
      return;
    }
    output.push(prefix);
    outputLength += prefix.length;
    const contentLength = contentEnd - contentStart;
    const contentRemaining = MAX_INLINE_BYTES - outputLength;
    const take = Math.min(contentLength, contentRemaining);
    if (take > 0) {
      output.push(raw.slice(contentStart, contentStart + take));
      outputLength += take;
    }
    if (take < contentLength) truncated = true;
  };

  for (let index = 0; index <= raw.length && lineIndex < end; index += 1) {
    if (index !== raw.length && raw.charCodeAt(index) !== 10) continue;
    const contentEnd = index > lineStart && raw.charCodeAt(index - 1) === 13 ? index - 1 : index;
    appendLine(lineStart, contentEnd);
    lineIndex += 1;
    lineStart = index + 1;
  }

  if (!truncated && end > start && outputLength >= MAX_INLINE_BYTES) truncated = true;
  const selectedLines = end - start;
  return {
    text: `${output.join("")}${truncated || lineIndex < end ? "\n… truncated" : ""}`,
    lines: selectedLines,
  };
};

const processTreeAlive = (pid: number) => {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const runTaskkill = (pid: number, force: boolean) => {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => undefined);
  killer.unref();
};

const signalProcessTree = (child: HostChildProcess, signal: "SIGKILL" | "SIGTERM") => {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (signal === "SIGTERM") {
      try {
        child.kill("SIGTERM");
      } catch {
        // taskkill below is the recursive fallback.
      }
      runTaskkill(pid, false);
    } else {
      runTaskkill(pid, true);
    }
    return;
  }
  try {
    // Detached POSIX children lead their own process group, so a negative PID reaches
    // the shell plus grandchildren (pipelines, package scripts, dev servers, etc.).
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // The process exited between the group and direct signal attempts.
    }
  }
};

const processTreeTerminator = (child: HostChildProcess, graceMs: number) => {
  let termination: Promise<void> | undefined;
  let finishTermination: (() => void) | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let exitPollTimer: ReturnType<typeof setInterval> | undefined;

  const finish = () => {
    if (forceTimer) clearTimeout(forceTimer);
    if (exitPollTimer) clearInterval(exitPollTimer);
    forceTimer = undefined;
    exitPollTimer = undefined;
    finishTermination?.();
    finishTermination = undefined;
  };

  return {
    terminate() {
      if (termination) return termination;
      termination = new Promise<void>((resolveTermination) => {
        finishTermination = resolveTermination;
      });
      if (child.pid === undefined) {
        finish();
        return termination;
      }
      signalProcessTree(child, "SIGTERM");
      if (process.platform !== "win32" && child.pid !== undefined) {
        exitPollTimer = setInterval(() => {
          if (!processTreeAlive(child.pid as number)) finish();
        }, 25);
        exitPollTimer.unref?.();
      }
      forceTimer = setTimeout(
        () => {
          signalProcessTree(child, "SIGKILL");
          // Give the OS a turn to reap the group before declaring shutdown complete.
          forceTimer = setTimeout(finish, 25);
        },
        Math.max(0, graceMs)
      );
      return termination;
    },
    rootClosed() {
      const pid = child.pid;
      if (!termination || pid === undefined || process.platform === "win32") return;
      if (!processTreeAlive(pid)) finish();
    },
  };
};

const pdfText = (path: string, signal?: AbortSignal): Promise<string> => {
  const child = spawn("pdftotext", [path, "-"], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tree = processTreeTerminator(child, SHELL_TERMINATION_GRACE_MS);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let reason: HostChildStopReason | undefined;
  let processError: Error | undefined;
  let settled = false;

  let result!: Promise<string>;
  const requestTermination = (nextReason: HostChildStopReason, error?: Error) => {
    reason ??= nextReason;
    processError ??= error;
    return tree.terminate();
  };
  const abort = () => void requestTermination("cancelled");

  result = new Promise<string>((resolveText, reject) => {
    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      tree.rootClosed();
      if (reason) await tree.terminate();
      signal?.removeEventListener("abort", abort);
      if (reason === "cancelled") reject(new Error("Host read was cancelled"));
      else if (reason === "shutdown") reject(new Error("Host jobs are shutting down"));
      else if (reason === "output_limit") reject(new Error("PDF text exceeds 10 MiB"));
      else if (processError) reject(processError);
      else if (code === 0) resolveText(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8") || "PDF conversion failed"));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (reason) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PDF_TEXT_BYTES) {
        void requestTermination("output_limit");
        child.stdout.resume();
        child.stderr.resume();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (reason || stderrBytes >= MAX_INLINE_BYTES) return;
      const piece = chunk.subarray(0, MAX_INLINE_BYTES - stderrBytes);
      stderr.push(piece);
      stderrBytes += piece.length;
    });
    child.once("error", (error) => {
      void requestTermination("spawn_error", error);
      if (child.pid === undefined) void finish(null);
    });
    child.once("close", (code) => void finish(code));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });

  const active: ActiveHostExecution = {
    terminate: (stopReason) => {
      void requestTermination(stopReason);
      return result.then(
        () => undefined,
        () => undefined
      );
    },
  };
  activeHostExecutions.add(active);
  void result.finally(() => activeHostExecutions.delete(active)).catch(() => undefined);
  return result;
};

export const executeRead = async (input: HostReadInput, signal?: AbortSignal) => {
  if (typeof input.path !== "string" || !isAbsolute(input.path)) {
    throw new Error("ExternalRead requires an absolute path");
  }
  signal?.throwIfAborted();
  const path = resolve(input.path);
  await access(path);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("ExternalRead path is not a file");
  if (metadata.size > MAX_READ_BYTES) throw new Error("ExternalRead file exceeds 10 MiB");
  const mimeType = imageMimeTypeForPath(path);
  if (mimeType) {
    const data = await readFile(path);
    signal?.throwIfAborted();
    return { kind: "image" as const, path, mimeType, data: data.toString("base64") };
  }
  let raw: string;
  if (extname(path).toLowerCase() === ".pdf") {
    const releaseSlot = await shellCapacity.acquire(signal);
    try {
      raw = await pdfText(path, signal);
    } finally {
      releaseSlot();
    }
  } else {
    raw = await readFile(path, "utf8");
  }
  signal?.throwIfAborted();
  return { kind: "text" as const, path, ...numberText(raw, input.offset, input.limit) };
};

const finishOutputFile = (stream: WriteStream, suffix: string) =>
  new Promise<void>((resolveEnd) => {
    if (stream.destroyed || stream.closed) {
      resolveEnd();
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      stream.off("error", finish);
      resolveEnd();
    };
    stream.once("error", finish);
    stream.end(suffix, finish);
  });

const resultOutput = (chunks: Buffer[], diagnostic?: string) => {
  const output = Buffer.concat(chunks);
  if (!diagnostic) return output.toString("utf8");
  const diagnosticBytes = Buffer.from(`${output.length > 0 ? "\n" : ""}… ${diagnostic}`);
  const keptOutput = output.subarray(0, Math.max(0, MAX_INLINE_BYTES - diagnosticBytes.length));
  return Buffer.concat([
    keptOutput,
    diagnosticBytes.subarray(0, MAX_INLINE_BYTES - keptOutput.length),
  ]).toString("utf8");
};

export interface HostShellExecutionOptions {
  maxRuntimeMs?: number;
  terminationGraceMs?: number;
}

interface ShellOutcome {
  exitCode: number | null;
  reason?: HostChildStopReason;
  error?: Error;
}

export const executeShell = async (
  input: HostShellInput,
  terminalDir: string,
  signal?: AbortSignal,
  executionOptions: HostShellExecutionOptions = {}
) => {
  if (typeof input.command !== "string") throw new Error("ExternalShell command is required");
  const workingDirectory =
    input.working_directory === undefined
      ? process.cwd()
      : typeof input.working_directory === "string" && isAbsolute(input.working_directory)
        ? resolve(input.working_directory)
        : (() => {
            throw new Error("ExternalShell working_directory must be absolute");
          })();
  const directory = await stat(workingDirectory);
  if (!directory.isDirectory()) {
    throw new Error("ExternalShell working_directory is not a directory");
  }
  await mkdir(terminalDir, { recursive: true });
  if (signal?.aborted) throw new Error("Host shell was cancelled");

  const releaseSlot = await shellCapacity.acquire(signal);
  let slotOwnedByExecution = false;
  let outputFile: WriteStream | undefined;
  let terminateUntrackedChild: (() => Promise<void>) | undefined;
  try {
    if (signal?.aborted) throw new Error("Host shell was cancelled");
    const shellId = crypto.randomUUID();
    const outputPath = resolve(terminalDir, `${shellId}.log`);
    outputFile = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
    const startedAt = Date.now();
    const logHeader = `command: ${input.command}\nworking_directory: ${workingDirectory}\nstarted_at: ${new Date(startedAt).toISOString()}\n\n`;
    const logHeaderBytes = Buffer.byteLength(logHeader);
    if (logHeaderBytes + SHELL_LOG_FOOTER_RESERVE_BYTES > MAX_SHELL_LOG_BYTES) {
      throw new Error("ExternalShell command metadata exceeds the terminal log limit");
    }
    const commandLogBudget = MAX_SHELL_LOG_BYTES - logHeaderBytes - SHELL_LOG_FOOTER_RESERVE_BYTES;
    const child = spawn(input.command, [], {
      cwd: workingDirectory,
      detached: process.platform !== "win32",
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxRuntimeMs = Math.max(1, executionOptions.maxRuntimeMs ?? MAX_SHELL_RUNTIME_MS);
    const terminationGraceMs = Math.max(
      0,
      executionOptions.terminationGraceMs ?? SHELL_TERMINATION_GRACE_MS
    );
    const tree = processTreeTerminator(child, terminationGraceMs);
    terminateUntrackedChild = () => tree.terminate();
    const inlineChunks: Buffer[] = [];
    let inlineBytes = 0;
    let logBytes = 0;
    let pausedForBackpressure = false;
    let stopReason: HostChildStopReason | undefined;
    let processError: Error | undefined;
    let childClosed = false;
    let settled = false;
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;

    const resumeStreams = () => {
      pausedForBackpressure = false;
      child.stdout.resume();
      child.stderr.resume();
    };
    const requestTermination = (reason: HostChildStopReason, error?: Error) => {
      stopReason ??= reason;
      processError ??= error;
      outputFile?.off("drain", resumeStreams);
      resumeStreams();
      return childClosed ? Promise.resolve() : tree.terminate();
    };
    const abort = () => void requestTermination("cancelled");
    const onOutputError = (error: Error) => {
      void requestTermination("output_stream_error", error);
    };
    const collect = (chunk: Buffer) => {
      if (stopReason) return;
      if (inlineBytes < MAX_INLINE_BYTES) {
        const remaining = MAX_INLINE_BYTES - inlineBytes;
        const piece = chunk.subarray(0, remaining);
        inlineChunks.push(piece);
        inlineBytes += piece.length;
      }
      const remainingLogBytes = commandLogBudget - logBytes;
      const piece = chunk.subarray(0, Math.max(0, remainingLogBytes));
      logBytes += piece.length;
      if (piece.length > 0 && !outputFile?.write(piece) && !pausedForBackpressure) {
        pausedForBackpressure = true;
        child.stdout.pause();
        child.stderr.pause();
        outputFile?.once("drain", resumeStreams);
      }
      if (piece.length < chunk.length) void requestTermination("output_limit");
    };

    let resolveCompletion!: (outcome: ShellOutcome) => void;
    const completion = new Promise<ShellOutcome>((resolveOutcome) => {
      resolveCompletion = resolveOutcome;
    });
    const finalize = async (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      childClosed = true;
      tree.rootClosed();
      if (runtimeTimer) clearTimeout(runtimeTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout.off("data", collect);
      child.stderr.off("data", collect);
      outputFile?.off("drain", resumeStreams);
      if (stopReason) await tree.terminate();
      else if (
        process.platform !== "win32" &&
        child.pid !== undefined &&
        processTreeAlive(child.pid)
      ) {
        // A shell can exit after daemonizing a redirected descendant, which would
        // otherwise escape both the global process-tree cap and shutdown tracking.
        await tree.terminate();
      }
      const elapsedMs = Date.now() - startedAt;
      const status =
        stopReason === "output_limit"
          ? "terminated: output exceeded 64 MiB"
          : stopReason === "timed_out"
            ? "timed out"
            : stopReason === "cancelled"
              ? "cancelled"
              : stopReason === "shutdown"
                ? "terminated: app shutting down"
                : stopReason
                  ? "failed"
                  : "completed";
      if (outputFile) {
        await finishOutputFile(
          outputFile,
          `\n\nstatus: ${status}\nexit_code: ${exitCode ?? "null"}\nelapsed_ms: ${elapsedMs}\n`
        );
        outputFile.off("error", onOutputError);
      }
      resolveCompletion({ exitCode, reason: stopReason, error: processError });
    };

    outputFile.on("error", onOutputError);
    if (!outputFile.write(logHeader)) {
      pausedForBackpressure = true;
      child.stdout.pause();
      child.stderr.pause();
      outputFile.once("drain", resumeStreams);
    }
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      void requestTermination("spawn_error", error);
      if (child.pid === undefined) void finalize(null);
    });
    child.once("close", (code) => void finalize(code));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    runtimeTimer = setTimeout(() => void requestTermination("timed_out"), maxRuntimeMs);

    const active: ActiveHostExecution = {
      terminate: (reason) => {
        void requestTermination(reason);
        return completion.then(() => undefined);
      },
    };
    activeHostExecutions.add(active);
    slotOwnedByExecution = true;
    terminateUntrackedChild = undefined;
    void completion
      .finally(() => {
        activeHostExecutions.delete(active);
        releaseSlot();
      })
      .catch(() => undefined);

    const requested = typeof input.block_until_ms === "number" ? input.block_until_ms : 30_000;
    const blockMs = Math.max(0, Math.min(7_140_000, requested));
    let blockTimer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      completion.then((outcome) => ({ done: true as const, outcome })),
      new Promise<{ done: false }>(
        (resolveTimeout) =>
          (blockTimer = setTimeout(() => resolveTimeout({ done: false }), blockMs))
      ),
    ]);
    if (blockTimer) clearTimeout(blockTimer);

    if (!completed.done) {
      return {
        shell_id: shellId,
        status: "running" as const,
        exit_code: null,
        output: resultOutput(inlineChunks),
        output_path: outputPath,
        elapsed_ms: Date.now() - startedAt,
      };
    }

    const { outcome } = completed;
    if (outcome.reason === "cancelled") throw new Error("Host shell was cancelled");
    if (outcome.reason === "shutdown") throw new Error("Host jobs are shutting down");
    if (outcome.reason === "spawn_error" || outcome.reason === "output_stream_error") {
      throw outcome.error ?? new Error("Host shell failed");
    }
    const diagnostic =
      outcome.reason === "timed_out"
        ? `Host shell timed out after ${maxRuntimeMs} ms; complete output is in ${outputPath}`
        : outcome.reason === "output_limit"
          ? `Host shell output exceeded 64 MiB; complete output is in ${outputPath}`
          : undefined;
    return {
      shell_id: shellId,
      status:
        outcome.reason === "timed_out" || outcome.reason === "output_limit"
          ? ("failed" as const)
          : ("completed" as const),
      exit_code: outcome.exitCode,
      output: resultOutput(inlineChunks, diagnostic),
      output_path: outputPath,
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (error) {
    if (!slotOwnedByExecution) {
      await terminateUntrackedChild?.();
      outputFile?.destroy();
      releaseSlot();
    }
    throw error;
  }
};

export const executeHostJob = (payload: HostJobPayload, signal?: AbortSignal) => {
  if (payload.kind === "read") return executeRead(payload.input, signal);
  return executeShell(payload.input, payload.terminalDir, signal);
};

export const terminateHostChildren = async () => {
  shellCapacity.cancelQueued();
  await Promise.allSettled(
    [...activeHostExecutions].map((execution) => execution.terminate("shutdown"))
  );
};
