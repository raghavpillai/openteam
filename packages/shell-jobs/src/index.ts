import { open, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RE2JS } from "re2js";
import { parseHostAwaitShellRequest } from "@openteam/contracts/service-protocol";
import type { ShellAwaitRequest, ShellAwaitResponse } from "@openteam/contracts/service-protocol";
export { createShellEnvironmentCapture, loadShellEnvironment, persistShellEnvironment, SHELL_ENVIRONMENT_CAPTURE } from "./environment";

const MAX_PATTERN_BYTES = 64 * 1024 * 1024;
const MAX_COMPLETED_JOBS = 256;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

interface Job {
  id: string;
  scope: string;
  outputPath: string;
  outputOffset: number;
  startedAt: number;
  pid?: number;
  outputBytes: number;
  outcome?: { exitCode: number | null; error?: string; finishedAt: number };
  listeners: Set<() => void>;
  recovered?: boolean;
  background?: boolean;
  notified?: boolean;
  channelId?: string;
}

export interface ShellCompletion {
  id: string; scope: string; outputPath: string; exitCode: number | null; error?: string;
  channelId?: string;
}

export function validateShellWait(input: ShellAwaitRequest): number {
  input = parseHostAwaitShellRequest(input);
  const blockMs = input.block_until_ms ?? 30_000;
  if (!Number.isFinite(blockMs) || blockMs < 0 || blockMs > 7_140_000) {
    throw new Error("AwaitShell block_until_ms must be between 0 and 7140000");
  }
  if (input.shell_id !== undefined && (typeof input.shell_id !== "string" || !input.shell_id)) {
    throw new Error("AwaitShell shell_id must be a nonempty string");
  }
  if (!input.shell_id && blockMs === 0) {
    throw new Error("AwaitShell shell_id is required with block_until_ms: 0");
  }
  if (input.pattern !== undefined) {
    if (typeof input.pattern !== "string" || input.pattern.length > 4_096) {
      throw new Error("AwaitShell pattern must be a string of at most 4096 characters");
    }
    try {
      RE2JS.compile(input.pattern, RE2JS.MULTILINE);
    } catch {
      throw new Error("AwaitShell pattern must be a valid RE2 regular expression (lookarounds and backreferences are unsupported)");
    }
  }
  return blockMs;
}

/** Wait cancellation never owns or terminates the underlying shell process. */
function waitForChange(job: Job | undefined, milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolveWait, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      job?.listeners.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolveWait();
    };
    const onChange = () => finish();
    const onAbort = () => finish(signal?.reason ?? new Error("AwaitShell cancelled"));
    const timer = setTimeout(onChange, milliseconds);
    job?.listeners.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Durable terminal receipts; restart recovery observes files without killing processes. */
export class ShellJobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly notifying = new Set<string>();
  private readonly pollTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: { directory?: string; onComplete?: (job: ShellCompletion) => Promise<void> } = {}) {
    if (options.directory && existsSync(options.directory)) {
      for (const name of readdirSync(options.directory)) {
        if (name.endsWith(".log.job.json")) this.restore(name.slice(0, -13), options.directory);
      }
    }
    if (options.onComplete) {
      this.pollTimer = setInterval(() => void this.flushCompletions(), 1000);
      this.pollTimer.unref();
    }
  }

  dispose() { if (this.pollTimer) clearInterval(this.pollTimer); }

  private persist(job: Job) {
    const { listeners: _listeners, recovered: _recovered, ...receipt } = job;
    const path = `${job.outputPath}.job.json`;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, path);
  }

  private restore(id: string, directory: string): Job | undefined {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
    try {
      const path = join(directory, `${id}.log`);
      const receipt = JSON.parse(readFileSync(`${path}.job.json`, "utf8")) as Job;
      if (receipt.id !== id || resolve(receipt.outputPath) !== resolve(path) || typeof receipt.scope !== "string" || !Number.isFinite(receipt.outputOffset) || !Number.isFinite(receipt.startedAt)) return;
      const job: Job = { ...receipt, recovered: true, listeners: new Set() };
      this.jobs.set(id, job);
      return job;
    } catch { return; }
  }

  private async refresh(job: Job) {
    if (!job.recovered || job.outcome) return;
    const file = await open(job.outputPath, "r");
    try {
      const size = (await file.stat()).size;
      const tail = Buffer.alloc(Math.min(2048, size));
      await file.read(tail, 0, tail.length, size - tail.length);
      const footer = tail.toString("utf8").match(/\n\nstatus: ([^\n]+)\nexit_code: (-?\d+|null)\nelapsed_ms: (\d+)\n$/);
      job.outputBytes = Math.max(0, size - job.outputOffset - (footer ? Buffer.byteLength(footer[0]) : 0));
      if (footer) {
        job.outcome = { exitCode: footer[2] === "null" ? null : Number(footer[2]), finishedAt: job.startedAt + Number(footer[3]), ...(footer[1] === "completed" ? {} : { error: footer[1] }) };
        this.persist(job);
      } else if (job.pid) {
        try { process.kill(job.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            job.outcome = { exitCode: null, finishedAt: Date.now(), error: "The shell process ended without a completion footer; inspect its output file." };
            this.persist(job);
          }
        }
      }
    } finally { await file.close(); }
  }

  markBackground(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.background = true;
    this.persist(job);
    void this.flushCompletions();
  }

  async flushCompletions() {
    if (!this.options.onComplete) return;
    for (const job of this.jobs.values()) {
      if (!job.background || job.notified || this.notifying.has(job.id)) continue;
      this.notifying.add(job.id);
      try {
        await this.refresh(job);
        if (!job.outcome) continue;
        await this.options.onComplete({ id: job.id, scope: job.scope, outputPath: job.outputPath, channelId: job.channelId, ...job.outcome });
        job.notified = true;
        this.persist(job);
      } catch { /* Retry after restart or a transient control-plane outage. */ }
      finally { this.notifying.delete(job.id); }
    }
  }

  start(options: Omit<Job, "outputBytes" | "outcome" | "listeners">) {
    this.prune();
    const job: Job = { ...options, outputBytes: 0, listeners: new Set() };
    this.jobs.set(job.id, job);
    this.persist(job);
    const notify = () => {
      for (const listener of [...job.listeners]) listener();
    };
    return {
      // Call only after the log write completes, so pattern readers see these bytes.
      outputWritten: (bytes: number) => {
        job.outputBytes += bytes;
        notify();
      },
      finish: (exitCode: number | null, error?: string) => {
        if (job.outcome) return;
        job.outcome = { exitCode, error, finishedAt: Date.now() };
        this.persist(job);
        notify();
        void this.flushCompletions();
        this.prune();
      },
    };
  }

  async await(
    input: ShellAwaitRequest,
    scope: string,
    signal?: AbortSignal
  ): Promise<ShellAwaitResponse> {
    input = parseHostAwaitShellRequest(input);
    const blockMs = validateShellWait(input);
    signal?.throwIfAborted();
    const waitedAt = Date.now();
    if (!input.shell_id) {
      await waitForChange(undefined, blockMs, signal);
      return { status: "slept", waited_ms: Date.now() - waitedAt };
    }
    this.prune();
    const directory = this.options.directory ?? (isAbsolute(scope) ? scope : undefined);
    const job = this.jobs.get(input.shell_id) ?? (directory ? this.restore(input.shell_id, directory) : undefined);
    if (!job || job.scope !== scope) {
      throw new Error(
        "Unknown or expired shell_id. Use a Shell ID from this runtime and the same machine; use Read for older logs."
      );
    }
    const deadline = waitedAt + blockMs;
    let scannedBytes = -1;
    let regexMatch: string | null = null;
    let patternMatched = false;
    for (;;) {
      signal?.throwIfAborted();
      await this.refresh(job);
      const outputBytes = job.outputBytes;
      if (input.pattern !== undefined && scannedBytes !== outputBytes) {
        regexMatch = await this.matches(job, outputBytes, input.pattern, signal);
        patternMatched = regexMatch !== null;
        scannedBytes = outputBytes;
      }
      signal?.throwIfAborted();
      // Output or completion may have arrived during the file read. Scan the final
      // committed bytes before reporting completion or subscribing to changes.
      if (
        input.pattern !== undefined &&
        scannedBytes !== job.outputBytes &&
        !patternMatched &&
        (job.outcome || Date.now() < deadline)
      )
        continue;
      if (job.outcome || patternMatched || Date.now() >= deadline) {
        return {
          shell_id: job.id,
          status: job.outcome ? (job.outcome.error ? "failed" : "completed") : "running",
          exit_code: job.outcome?.exitCode ?? null,
          output_path: job.outputPath,
          output_length: (await stat(job.outputPath)).size,
          elapsed_ms: (job.outcome?.finishedAt ?? Date.now()) - job.startedAt,
          waited_ms: Date.now() - waitedAt,
          ...(job.pid === undefined ? {} : { pid: job.pid }),
          ...(input.pattern === undefined ? {} : { pattern_matched: patternMatched }),
          ...(regexMatch === null ? {} : { regex_match: regexMatch }),
          ...(job.outcome?.error ? { error: job.outcome.error } : {}),
        };
      }
      await waitForChange(job, Math.min(250, Math.max(0, deadline - Date.now())), signal);
    }
  }

  private async matches(job: Job, bytes: number, pattern: string, signal?: AbortSignal) {
    if (bytes > MAX_PATTERN_BYTES) {
      throw new Error(
        "AwaitShell pattern matching supports up to 64 MiB of output. Omit pattern to wait for completion."
      );
    }
    const buffer = Buffer.alloc(bytes);
    if (bytes > 0) {
      const file = await open(job.outputPath, "r");
      try {
        let offset = 0;
        while (offset < bytes) {
          signal?.throwIfAborted();
          const result = await file.read(buffer, offset, bytes - offset, job.outputOffset + offset);
          if (!result.bytesRead)
            throw new Error("Shell output log was truncated while awaiting it");
          offset += result.bytesRead;
        }
      } finally {
        await file.close();
      }
    }
    signal?.throwIfAborted();
    try {
      const matcher = RE2JS.compile(pattern, RE2JS.MULTILINE).matcher(buffer.toString("utf8"));
      return matcher.find() && matcher.group(0) ? matcher.group(0) : null;
    } catch {
      throw new Error(
        "AwaitShell pattern matching failed"
      );
    }
  }

  private prune() {
    const cutoff = Date.now() - RETENTION_MS;
    const completed = [...this.jobs.values()]
      .filter((job) => job.outcome && (!job.background || job.notified || !this.options.onComplete))
      .sort((a, b) => a.outcome!.finishedAt - b.outcome!.finishedAt);
    let excess = completed.length - MAX_COMPLETED_JOBS;
    for (const job of completed) {
      if (job.outcome!.finishedAt < cutoff || excess > 0) {
        this.jobs.delete(job.id);
        excess--;
      }
    }
  }
}

export function compileToolSearchPattern(source: string): { test(text: string): boolean } {
  const expression = RE2JS.compile(source, RE2JS.CASE_INSENSITIVE);
  return { test: (text) => expression.matcher(text).find() };
}

export function renderShellAwaitResult(result: ShellAwaitResponse): string {
  if (result.status === "slept") return `Slept for ${Math.max(1, Math.ceil(result.waited_ms / 1000))} seconds.`;
  const status = result.status === "running"
    ? `Task still running after ${result.waited_ms}ms.`
    : `Task completed in ${result.elapsed_ms}ms with exit code: ${result.exit_code ?? "unknown"}.`;
  return [status, result.error, `Output file: ${result.output_path}`, `Output length: ${result.output_length}`, result.regex_match ? `Pattern matched: ${result.regex_match}` : ""].filter(Boolean).join("\n");
}
