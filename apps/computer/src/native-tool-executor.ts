import { MachineDirectory } from "./machine-directory";
import { DESKTOP_MESSAGES_TOOLS } from "@openteam/contracts/desktop-capability-names";
import type { TaskConfiguration } from "@openteam/contracts/task-configuration";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { agentReadStream, agentWriteStream } from "./agent-file-stream";
import { formatBytes2 } from "@openteam/contracts/reference-formatters";
import { READ_CHAR_LIMIT, ReadWindowText, formatNotebookForModel, readLineWindow, renderReadText, renderPdfReadText } from "@openteam/contracts/read-output";
import { boundToolImage, resizeImageForModel } from "./runtime/image-input";
import { decodeReadableText, readableTextEncoding, sniffImageMimeType } from "./read-text";
import { randomInt, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  AwaitShellInput,
  ReadToolInput,
  ShellToolInput,
  TaskInput,
} from "@openteam/contracts";
import { ShellJobRegistry, SecretRedactor, redactSecrets, validateShellWait, renderShellAwaitResult, type ShellCompletion } from "@openteam/shell-jobs";
import { createShellEnvironmentCapture, loadShellEnvironment, SHELL_ENVIRONMENT_CAPTURE } from "@openteam/shell-jobs";
import {
  SHELL_FILE_OUTPUT_THRESHOLD_BYTES,
  SHELL_OOM_NOTE,
  ShellOutputCollector,
  formatInterruptedShellResult,
  formatShellBackgroundedResult,
  formatShellCompletedResult,
  formatShellStartedResult,
  shellTimedOutIntro,
  terminalFooter,
  terminalFrontmatter,
  truncateShellOutput,
  type TerminalStatus,
} from "@openteam/shell-jobs";
import {
  HOST_BRIDGE_PATHS,
  HOST_INLINE_OUTPUT_MAX_BYTES,
  HOST_TRANSFER_MAX_BYTES,
  type HostMachine,
  type HostReadRequest,
  type HostShellRequest,
  imageMimeTypeForPath,
  parseHostMachinesResponse,
  parseHostReadResponse,
  parseHostShellResponse,
  parseShellAwaitResponse,
} from "@openteam/contracts/service-protocol";
import { spawnAgentProcess as spawn, agentProcessIdentity, agentProcessGroupSignaler, AGENT_SEARCH_PATHS, sanitizedAgentEnvironment, withAgentSearchPaths } from "./agent-process";
import { agentFileIO } from "./agent-file-io";
import { protectedAgentDataPath } from "@openteam/contracts/agent-file-access";

const DEFAULT_BLOCK_MS = 30_000;
// How long a stopped command may keep its output open after the group kill (SIGKILL follows at 500 ms).
const STOPPED_SHELL_GRACE_MS = 2_000;
/** Text files above this size are streamed rather than loaded whole. */
const READ_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** Archives and media Read refuses by name, as in the reference. */
const UNSUPPORTED_BINARY_EXTENSIONS = /\.(zip|tar|gz|exe|dll|so|dylib|bin|mp4|webm|mov|avi|mkv|wmv|flv|m4v)$/i;

interface ReadSource {
  bytes(): Promise<Buffer>;
  stream(): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

/** A Read result the model sees verbatim and flagged as failed (no "Error: " prefix). */
class ReadResultError extends Error {}
const SHELL_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
/** How often a running command's terminal header refreshes `running_for_ms`. */
const TERMINAL_HEADER_UPDATE_MS = 5_000;
// Shell output logs are named by their numeric shell_id.
const TERMINAL_LOG_NAME = /^[0-9]+\.log$/;

export const sanitizedShellEnvironment = (
  source: NodeJS.ProcessEnv,
  workingDirectory: string
): NodeJS.ProcessEnv => sanitizedAgentEnvironment(source, { PWD: workingDirectory });

const localPath = (path: string, cwd: string): string =>
  isAbsolute(path) ? resolve(path) : resolve(cwd, path);

const textResult = (
  text: string,
  details: Record<string, unknown> = {}
): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text }],
  details,
});

export interface CopyFileInput { computer_path?: string; box_path?: string; machineId: string }

export class NativeToolExecutor {
  async desktopCapability(tool: string, botId: string, args: unknown, signal?: AbortSignal, callId?: string, channelId?: string): Promise<Record<string, any>> {
    if (!(DESKTOP_MESSAGES_TOOLS as readonly string[]).includes(tool)) {
      const machineId = await this.machines?.preferred(botId, channelId, signal);
      return this.hostFetch(HOST_BRIDGE_PATHS.capabilities, { tool, botId, arguments: args, callId, machineId }, signal, undefined, 15 * 60_000);
    }
    // Messages runs only on a Mac that turned it on; the server picks one when the call names none.
    const { machineId: requested, ...rest } = (args ?? {}) as Record<string, unknown>;
    if (!this.machines) throw new Error("Messages needs the OpenTeam server's computer directory");
    const machineId = await this.machines.messagesMachine(botId, channelId, typeof requested === "string" ? requested : undefined, signal);
    return this.hostFetch(HOST_BRIDGE_PATHS.capabilities, { tool, botId, arguments: rest, callId, machineId }, signal, undefined, 15 * 60_000);
  }

  /** Whether any connected Mac offers Messages right now. */
  messagesAvailable(signal?: AbortSignal): Promise<boolean> {
    return this.machines ? this.machines.messagesAvailable(signal).catch(() => false) : Promise.resolve(false);
  }
  private readonly shellJobs: ShellJobRegistry;
  private readonly liveShells = new Map<string, { scope: string; background: boolean; stop: () => void }>();
  private readonly terminalDir: string;
  private readonly hostBridgeUrl: string;
  private readonly machines?: MachineDirectory;
  private readonly controlToken: string;
  private readonly serverUrl?: string;
  private readonly agentDataCanonicalRoot: string;
  private readonly shellHardTimeoutMs: number;

  constructor(options: {
    agentDir: string;
    controlToken: string;
    hostBridgeUrl?: string;
    serverUrl?: string;
    agentDataCanonicalRoot?: string;
    onShellComplete?: (job: ShellCompletion) => Promise<void>;
    shellHardTimeoutMs?: number;
  }) {
    this.shellHardTimeoutMs = options.shellHardTimeoutMs ?? SHELL_HARD_TIMEOUT_MS;
    this.terminalDir = resolve(options.agentDir, "terminals");
    this.shellJobs = new ShellJobRegistry({ directory: this.terminalDir, onComplete: options.onShellComplete });
    this.controlToken = options.controlToken;
    this.serverUrl = options.serverUrl;
    this.hostBridgeUrl =
      options.hostBridgeUrl ??
      process.env.OPENTEAM_HOST_BRIDGE_URL ??
      "http://host.docker.internal:8791";
    if(options.serverUrl)this.machines = new MachineDirectory(options.serverUrl,this.controlToken,this.hostBridgeUrl);
    this.agentDataCanonicalRoot = resolve(
      options.agentDataCanonicalRoot ??
        process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT ??
        "/home/box/sand-data"
    );
  }

  /** A stopped subagent's background commands end with it, through the same stop as an interrupted call. */
  stopBackgroundShells(scope: string): number {
    const running = [...this.liveShells.values()].filter((shell) => shell.scope === scope && shell.background);
    for (const shell of running) shell.stop();
    return running.length;
  }

  /** A routine run that handed off to its parent stops the background commands it started. */
  stopAutomationShells(automationRunIds: readonly string[]): number {
    const running = this.shellJobs.runningForAutomation(new Set(automationRunIds));
    // The same stop as an interrupted call: TERM, then KILL, and the log records an abort.
    for (const job of running) this.liveShells.get(job.id)?.stop();
    return running.length;
  }

  /** A descendant that left the process group (setsid) can hold the output pipes open after the kill; stop waiting for it. */
  private async stoppedCompletion(child: ChildProcess, completion: Promise<number | null>) {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolveGrace) => (graceTimer = setTimeout(() => resolveGrace(false), STOPPED_SHELL_GRACE_MS))),
    ]);
    clearTimeout(graceTimer);
    if (!closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
    return completion;
  }

  async shellWorkingDirectory(input: Pick<ShellToolInput, "working_directory">, cwd: string, scope = "") {
    if (input.working_directory != null) return localPath(input.working_directory, cwd);
    const saved = await loadShellEnvironment(this.terminalDir, scope, {});
    const persisted = saved.environment.PWD;
    return persisted && isAbsolute(persisted) ? persisted : cwd;
  }

  async shell(
    input: ShellToolInput,
    cwd: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
    scope = "",
    routing: { channelId?: string; automationRunId?: string; secrets?: string[]; secretEnvironment?: Record<string, string> } = {}
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const workingDirectory = await this.shellWorkingDirectory(input, cwd, scope);
    if (!(await stat(workingDirectory).catch(() => undefined))?.isDirectory()) {
      if (input.working_directory != null)
        throw new Error(`Error: Command failed to spawn: working directory does not exist: ${workingDirectory}; the command did not run`);
      // Never run a command somewhere else after its remembered directory was deleted.
      return textResult(formatShellCompletedResult({
        exitCode: 1,
        elapsedMs: Date.now() - startedAt,
        output: truncateShellOutput(`The shell's working directory no longer exists: ${workingDirectory}. The command did not run. Re-run it with working_directory set to an existing directory.\n`),
      }), { status: "completed", exitCode: 1 });
    }
    await mkdir(this.terminalDir, { recursive: true });
    const savedEnvironment = await loadShellEnvironment(this.terminalDir, scope, environment ?? { ...process.env, ...AGENT_SEARCH_PATHS }, environment);
    const secrets = routing.secrets ?? [];

    const shellId = String(randomInt(100000, 2147483647));
    const outputPath = resolve(this.terminalDir, `${shellId}.log`);
    const outputFile = createWriteStream(outputPath, {
      flags: "wx",
      mode: 0o600,
    });

    const environmentCapture = createShellEnvironmentCapture(dirname(savedEnvironment.path));
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", `${SHELL_ENVIRONMENT_CAPTURE}\n${input.command}`], {
      cwd: workingDirectory,
      env: { ...sanitizedShellEnvironment(withAgentSearchPaths(savedEnvironment.environment), workingDirectory), ...routing.secretEnvironment, OPENTEAM_DESKTOP_ID: environment?.OPENTEAM_DESKTOP_ID },
      ...agentProcessIdentity(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", environmentCapture.fd],
    });
    environmentCapture.closeParent();
    const command = redactSecrets(input.command, secrets);
    const title = input.description?.trim() ? redactSecrets(input.description, secrets) : undefined;
    const frontmatter = (status: TerminalStatus) => terminalFrontmatter({
      pid: child.pid, cwd: workingDirectory, command, title, status,
      startedAt: new Date(startedAt).toISOString(), runningForMs: Date.now() - startedAt,
    });
    const header = frontmatter("running");
    const headerBytes = Buffer.byteLength(header);
    outputFile.write(header);
    let headerUpdate = Promise.resolve();
    const rewriteHeader = (status: TerminalStatus) => (headerUpdate = headerUpdate.then(async () => {
      const next = frontmatter(status);
      // The fixed-width fields keep the length; if the running time ever outgrows
      // its padding, stop updating rather than overwrite the first output bytes.
      if (Buffer.byteLength(next) !== headerBytes) return;
      const file = await open(outputPath, "r+");
      try { await file.write(next, 0, "utf8"); } finally { await file.close(); }
    }).catch(() => undefined));
    const headerTimer = setInterval(() => void rewriteHeader("running"), TERMINAL_HEADER_UPDATE_MS);
    headerTimer.unref();

    const job = this.shellJobs.start({
      id: shellId,
      scope,
      outputPath,
      outputOffset: headerBytes,
      startedAt,
      pid: child.pid,
      channelId: routing.channelId,
      automationRunId: routing.automationRunId,
      title: (title ?? command).slice(0, 4000),
    });
    const output = new ShellOutputCollector();
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (!chunk.length) return;
      outputFile.write(chunk, (error) => {
        if (!error) job.outputWritten(chunk.length);
      });
      output.push(chunk, stream);
    };
    const stdoutRedactor = new SecretRedactor(secrets);
    const stderrRedactor = new SecretRedactor(secrets);
    child.stdout!.on("data", chunk => collect(stdoutRedactor.write(chunk), "stdout"));
    child.stderr!.on("data", chunk => collect(stderrRedactor.write(chunk), "stderr"));
    child.stdout!.once("end", () => collect(stdoutRedactor.end(), "stdout"));
    child.stderr!.once("end", () => collect(stderrRedactor.end(), "stderr"));

    const signalGroup = agentProcessGroupSignaler(child);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let abortedAt: number | undefined;
    const terminate = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 500);
    };
    let stopped!: () => void;
    const stopRequested = new Promise<{ done: false }>((resolveStop) => (stopped = () => resolveStop({ done: false })));
    const abort = () => {
      abortedAt ??= Date.now();
      terminate();
      stopped();
    };
    const live = { scope, background: false, stop: abort };
    this.liveShells.set(shellId, live);
    // Like the reference, no Shell command outlives a day, even in the background.
    let expired = false;
    const hardTimer = setTimeout(() => { expired = true; terminate(); }, this.shellHardTimeoutMs);
    hardTimer.unref();
    child.once("close", () => { if (killTimer) clearTimeout(killTimer); clearTimeout(hardTimer); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let processError: Error | undefined;
    let environmentError: Error | undefined;
    let exitSignal: NodeJS.Signals | null = null;
    let exitDirectory: string | undefined;
    const completion = new Promise<number | null>((resolveCompletion) => {
      let closed = false;
      let settled = false;
      let exitCode: number | null = null;
      const finish = async () => {
        if (settled) return;
        settled = true;
        this.liveShells.delete(shellId);
        clearInterval(headerTimer);
        try { exitDirectory = (await environmentCapture.persist(savedEnvironment.path, Object.keys(routing.secretEnvironment ?? {}), savedEnvironment.environment))?.PWD; }
        catch (error) { environmentError = error instanceof Error ? error : new Error("Could not persist shell environment"); }
        await rewriteHeader(abortedAt !== undefined || expired ? "aborted" : exitCode === 0 ? "succeeded" : "failed");
        // A command that ran to completion is reported as such even if its shell
        // state could not be saved; AwaitShell and the completion notice show its exit.
        job.finish(exitCode, expired ? `The command was stopped after running for ${this.shellHardTimeoutMs / 3_600_000} hours.` : processError?.message);
        resolveCompletion(exitCode);
      };
      child.once("error", (error) => {
        processError = error;
      });
      outputFile.on("error", (error) => {
        processError = error;
        child.kill("SIGTERM");
        if (closed) finish();
      });
      child.once("close", (code, closeSignal) => {
        closed = true;
        exitCode = code;
        exitSignal = closeSignal;
        if (outputFile.destroyed) {
          finish();
          return;
        }
        outputFile.end(terminalFooter(code, Date.now() - startedAt), finish);
      });
    });

    const blockMs = Math.max(0, Math.min(2_147_483_647, input.block_until_ms ?? DEFAULT_BLOCK_MS));
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let completed = await Promise.race([
      completion.then((exitCode) => ({ done: true as const, exitCode })),
      new Promise<{ done: false }>(
        (resolveTimeout) => (timeoutId = setTimeout(() => resolveTimeout({ done: false }), blockMs))
      ),
      stopRequested,
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    // A stopped command is being killed; report its interruption, not a backgrounding.
    if (!completed.done && abortedAt !== undefined) completed = { done: true, exitCode: await this.stoppedCompletion(child, completion) };
    signal?.removeEventListener("abort", abort);

    if (!completed.done) {
      live.background = true;
      this.shellJobs.markBackground(shellId);
      void completion.catch(() => undefined);
      const details = { shellId, status: "running", outputPath };
      if (blockMs === 0)
        return textResult(formatShellStartedResult({ shellId, pid: child.pid, command, outputPath }), details);
      return textResult(formatShellBackgroundedResult({
        intro: shellTimedOutIntro(blockMs),
        shellId,
        pid: child.pid,
        outputPath,
        partial: output.excerpt(),
      }), details);
    }

    const elapsedMs = Date.now() - startedAt;
    if (abortedAt !== undefined) throw new Error(formatInterruptedShellResult(abortedAt - startedAt, output.excerpt()));
    if (processError ?? environmentError) throw processError ?? environmentError;
    let spillPath: string | undefined;
    if (output.bytes > SHELL_FILE_OUTPUT_THRESHOLD_BYTES) {
      // The terminal log is supervisor-private, so the complete output also goes
      // to a file the agent can search with Shell, as the reference does.
      const path = resolve(cwd, ".openteam", "agent-tools", `${randomUUID()}.txt`);
      try {
        await agentWriteStream(path, createReadStream(outputPath, { start: headerBytes, end: headerBytes + output.bytes - 1 }));
        spillPath = path;
      } catch { /* The inline head and tail still show the output's ends. */ }
    }
    return textResult(
      formatShellCompletedResult({
        exitCode: completed.exitCode ?? -1,
        elapsedMs,
        ...(spillPath
          ? { outputLocation: { filePath: spillPath, sizeBytes: output.bytes, lineCount: output.lines } }
          : { output: output.excerpt() }),
        workingDirectory: input.working_directory != null ? (exitDirectory ?? workingDirectory) : undefined,
        note: exitSignal === "SIGKILL" || completed.exitCode === 137 ? SHELL_OOM_NOTE : undefined,
      }),
      {
        shellId,
        status: "completed",
        exitCode: completed.exitCode,
        outputPath,
        elapsedMs,
        ...(spillPath ? { spillPath } : {}),
      }
    );
  }

  async awaitShell(input: AwaitShellInput, signal?: AbortSignal, scope = "") {
    const result = await this.shellJobs.await(input, scope, signal);
    return textResult(renderShellAwaitResult(result), { ...result });
  }

  async externalAwaitShell(input: AwaitShellInput, signal?: AbortSignal) {
    const blockMs = validateShellWait(input);
    const result = await this.hostFetch(
      HOST_BRIDGE_PATHS.awaitShell,
      input,
      signal,
      parseShellAwaitResponse,
      Math.max(120_000, blockMs + 60_000)
    );
    return textResult(renderShellAwaitResult(result), { ...result });
  }

  async read(input: ReadToolInput, cwd: string): Promise<AgentToolResult<Record<string, unknown>>> {
    if (!input.path.trim()) throw new Error("Error: path is empty or only whitespace");
    const path = localPath(input.path, cwd);
    const binary = UNSUPPORTED_BINARY_EXTENSIONS.exec(path)?.[1];
    if (binary) throw new Error(`Error: Cannot read binary files of type ${binary.toLowerCase()}`);
    try { return await this.readLocal(path, input.offset, input.limit); }
    catch (error) {
      if (error instanceof ReadResultError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "ENOENT") throw Object.assign(new Error("Error: File not found"), { code });
      // The agent-user reader reports only the errno text.
      if (code === "EACCES" || code === "EPERM" || /^(EACCES|EPERM)\b/.test(message)) throw new Error("Error: Permission denied");
      throw new Error(`Error: ${message}`);
    }
  }

  async externalShell(
    input: ShellToolInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const request = { ...input } satisfies HostShellRequest;
    const blockMs = input.block_until_ms ?? DEFAULT_BLOCK_MS;
    const response = await this.hostFetch(
      HOST_BRIDGE_PATHS.shell,
      request,
      signal,
      parseHostShellResponse,
      Math.min(2_147_483_647, Math.max(120_000, blockMs + 60_000))
    ).catch((error) => {
      // The computer cannot see how far the command got before the call was stopped.
      if (signal?.aborted) throw new Error("Error: Shell command was interrupted before it completed. It may still be running.");
      throw error;
    });
    const details = { ...response };
    if (response.status === "running")
      return textResult(blockMs === 0
        ? formatShellStartedResult({ shellId: response.shell_id, command: input.command, outputPath: response.output_path })
        : formatShellBackgroundedResult({ intro: shellTimedOutIntro(blockMs), shellId: response.shell_id, outputPath: response.output_path, partial: truncateShellOutput(response.output) }), details);
    const bytes = Buffer.byteLength(response.output);
    // Large host output stays in the host's terminal log. The size is known only
    // when the host returned all of it.
    return textResult(formatShellCompletedResult({
      exitCode: response.exit_code ?? -1,
      elapsedMs: response.elapsed_ms,
      ...(bytes > SHELL_FILE_OUTPUT_THRESHOLD_BYTES
        ? { outputLocation: { filePath: response.output_path, sizeBytes: bytes, ...(bytes < HOST_INLINE_OUTPUT_MAX_BYTES ? { lineCount: response.output.split("\n").length - 1 } : {}) } }
        : { output: truncateShellOutput(response.output) }),
    }), details);
  }

  async externalRead(
    input: ReadToolInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const request = { ...input } satisfies HostReadRequest;
    const response = await this.hostFetch(
      HOST_BRIDGE_PATHS.read,
      request,
      signal,
      parseHostReadResponse
    );
    if (response.kind === "image" && response.data && response.mimeType) {
      return {
        content: [
          { type: "text", text: `Read image file: ${response.path}` },
          await boundToolImage(Buffer.from(response.data, "base64"), response.mimeType),
        ],
        details: { path: response.path, host: true },
      };
    }
    return textResult(response.text ?? "", {
      path: response.path,
      lines: response.lines ?? null,
      totalLines: response.totalLines,
      offset: response.offset,
      fileSize: response.fileSize,
      isEmpty: response.isEmpty,
      exceededLimit: response.exceededLimit,
      host: true,
    });
  }

  async listMachines(signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
    const response = this.machines ? {machines:await this.machines.list(signal)} : await this.hostFetch(HOST_BRIDGE_PATHS.machines,{},signal,parseHostMachinesResponse);
    return textResult(JSON.stringify({ machines: response.machines.map(machine => ({ machineId:machine.machineId, label:machine.label, connected:(machine as HostMachine & {connected?:boolean}).connected ?? true, messages:(machine as {messages?:string}).messages ?? "unavailable" })) }, null, 2), {
      machines: response.machines,
    });
  }

  async copyFile(direction: "toBox" | "fromBox", input: CopyFileInput, cwd: string, signal?: AbortSignal) {
    const toBox = direction === "toBox";
    const boxPath = localPath(input.box_path ?? `uploads/${basename(input.computer_path!)}`, cwd);
    const computerPath = input.computer_path ?? basename(boxPath);
    // Use the agent UID for actual I/O and retain the extra protected-data fence.
    if (!toBox) await this.assertProtectedReadPath(await realpath(boxPath));
    const sourceSize = toBox ? undefined : (await stat(boxPath)).size;
    const permit = await this.hostFetch<{ transferId: string; path: string }>(HOST_BRIDGE_PATHS.transfer, {
      direction: toBox ? "read" : "write", path: computerPath, machineId: input.machineId,
      ...(sourceSize !== undefined ? { bytes: sourceSize } : {}),
    }, signal);
    const source = toBox ? undefined : agentReadStream(boxPath, signal);
    let size=sourceSize ?? 0;
    try {
      const bridgeUrl = await this.machines?.endpoint(input.machineId,signal) ?? this.hostBridgeUrl;
      const response = await fetch(`${bridgeUrl}${HOST_BRIDGE_PATHS.transfer}/${encodeURIComponent(permit.transferId)}`, {
        method: toBox ? "GET" : "PUT", headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/octet-stream", ...(sourceSize === undefined ? {} : { "content-length": String(sourceSize) }) },
        ...(source ? { body: Readable.toWeb(source.stream) as unknown as ReadableStream<Uint8Array>, duplex:"half" } : {}), signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof error?.error === "string" ? error.error : `File transfer failed (${response.status})`);
      }
      if (toBox) {
        if (!response.body) throw new Error("File transfer returned no body");
        size = await agentWriteStream(boxPath,response.body,signal);
      } else await source!.done;
    } finally { source?.cancel(); }
    const label = await this.machineLabel(input.machineId, signal);

    return textResult(toBox
      ? `Copied ${permit.path} from ${label} into your box at ${boxPath} (${formatBytes2(size)}). Open it with Shell.`
      : `Copied ${boxPath} from your box to ${label} at ${permit.path} (${formatBytes2(size)}). The user can open it there with Shell using that computer's machineId.`,
    { box_path: boxPath, computer_path: permit.path, bytes: size, machineId: input.machineId });
  }

  private async machineLabel(machineId: string, signal?: AbortSignal): Promise<string> {
    try { const rows = this.machines ? await this.machines.registered(signal) : (await this.hostFetch(HOST_BRIDGE_PATHS.machines,{},signal,parseHostMachinesResponse)).machines; return rows.find(machine=>machine.machineId === machineId)?.label ?? machineId; }
    catch { return machineId; }
  }

  private async readLocal(
    path: string,
    offset?: number,
    limit?: number
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    await access(path);
    const canonical = await realpath(path);
    await this.assertProtectedReadPath(canonical);
    // The supervisor keeps terminal logs beside its private Pi credentials. Only
    // expose canonical numeric log paths, never adjacent files or symlink escapes.
    const terminalRoot = await realpath(this.terminalDir).catch(() => undefined);
    const terminalLog =
      terminalRoot !== undefined && TERMINAL_LOG_NAME.test(relative(terminalRoot, canonical));
    if (!terminalLog) await this.assertAgentReadable(canonical);
    const metadata = await stat(canonical);
    if (!metadata.isFile())
      throw new Error(`${metadata.isDirectory() ? "Path is a directory, not a file" : "Path is neither a file nor a directory"}: ${path}`);
    const extension = extname(canonical).toLowerCase();
    const isPdf = extension === ".pdf";
    const source = terminalLog ? await this.terminalLogSource(canonical, terminalRoot!) : await this.agentFileSource(canonical);
    try {
      // Large text files are streamed, keeping only the requested lines in memory.
      if (metadata.size > READ_STREAM_THRESHOLD_BYTES && !isPdf && !imageMimeTypeForPath(canonical))
        return await this.readLargeText(source, path, canonical, metadata.size, offset, limit);
      const bytes = await source.bytes();
      const plainText = decodeReadableText(bytes);

      const mimeType = plainText === undefined ? sniffImageMimeType(bytes) ?? imageMimeTypeForPath(canonical) : undefined;
      if (mimeType) {
        let image: Awaited<ReturnType<typeof resizeImageForModel>>;
        try { image = await resizeImageForModel(bytes, { webpWithoutCodec: "passthrough" }); }
        catch (error) {
          throw new Error(`File is not a valid image: its data could not be decoded (${error instanceof Error ? error.message : String(error)}). A truncated or hand-copied file does this; write it again from the original bytes with code.: ${path}`);
        }
        return {
          content: [
            { type: "text", text: `Read image file: ${canonical}` },
            { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
          ],
          details: { path: canonical, bytes: bytes.length, mimeType },
        };
      }

      let raw: string;
      if (isPdf) raw = await this.pdfText(bytes);
      else if (plainText === undefined) throw new Error(`File content is binary data, not text: ${path}`);
      else raw = plainText;
      const { text, ...details } = (isPdf ? renderPdfReadText : renderReadText)(raw, offset, limit, bytes.length);
      if (details.exceededLimit) throw new ReadResultError(text);
      const notebook = extension === ".ipynb" && offset === undefined && limit === undefined ? formatNotebookForModel(raw) : undefined;
      return textResult(notebook ?? text, { path: canonical, ...details });
    } finally { await source.close(); }
  }

  /** Two streaming passes: count the lines, then number only the requested window. */
  private async readLargeText(source: ReadSource, path: string, canonical: string, fileSize: number, offset?: number, limit?: number) {
    const decoded = async function* (encoding: string) {
      const decoder = new TextDecoder(encoding);
      for await (const chunk of source.stream()) yield decoder.decode(chunk, { stream: true });
      yield decoder.decode();
    };
    let sample = Buffer.alloc(0);
    for await (const chunk of source.stream()) {
      sample = Buffer.concat([sample, chunk]);
      if (sample.length >= 65_536) break;
    }
    const encoding = readableTextEncoding(sample);
    if (!encoding) throw new Error(`File content is binary data, not text: ${path}`);
    let newlines = 0;
    for await (const text of decoded(encoding))
      for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) newlines++;
    const totalLines = newlines + 1;
    const { start, end } = readLineWindow(totalLines, offset, limit);
    const window = new ReadWindowText(start);
    let line = 0;
    let pending = "";
    let open = true;
    scan: for await (const text of decoded(encoding)) {
      for (let from = 0; ;) {
        const newline = text.indexOf("\n", from);
        if (line >= start) {
          pending += newline === -1 ? text.slice(from) : text.slice(from, newline);
          // One enormous line must not be held in memory just to be refused.
          if (pending.length > READ_CHAR_LIMIT + 1) { window.push(line, pending); open = false; break scan; }
        }
        if (newline === -1) break;
        if (line >= start && !window.push(line, pending)) { open = false; break scan; }
        pending = "";
        if (++line >= end) { open = false; break scan; }
        from = newline + 1;
      }
    }
    if (open && line < end) window.push(line, pending);
    const { text, ...details } = window.render(totalLines, end, fileSize, false);
    if (details.exceededLimit) throw new ReadResultError(text);
    return textResult(text, { path: canonical, ...details });
  }

  private async agentFileSource(canonical: string): Promise<ReadSource> {
    const protectedRoot = await realpath(this.agentDataCanonicalRoot).catch(() => this.agentDataCanonicalRoot);
    return {
      bytes: () => agentFileIO("read", canonical, undefined, { protectedRoot }),
      stream: async function* () {
        const reader = agentReadStream(canonical, undefined, { protectedRoot });
        try {
          yield* reader.stream as AsyncIterable<Buffer>;
          await reader.done;
        } finally { reader.cancel(); }
      },
      close: async () => undefined,
    };
  }

  /** Supervisor-owned terminal logs are the sole privileged-read exception.
   * Pin the descriptor and recheck its actual target before returning bytes. */
  private async terminalLogSource(canonical: string, terminalRoot: string): Promise<ReadSource> {
    const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const actual = await realpath(process.platform === "linux" ? `/proc/self/fd/${file.fd}` : `/dev/fd/${file.fd}`);
      await this.assertProtectedReadPath(actual);
      if (dirname(actual) !== terminalRoot || !TERMINAL_LOG_NAME.test(basename(actual)))
        throw new Error("Read terminal log target changed");
      const pinned = await file.stat();
      if (!pinned.isFile() || pinned.size > HOST_TRANSFER_MAX_BYTES)
        throw new Error("Source must be a regular file within the transfer size limit");
    } catch (error) { await file.close(); throw error; }
    return {
      bytes: () => file.readFile(),
      stream: () => file.createReadStream({ start: 0, autoClose: false }) as AsyncIterable<Buffer>,
      close: () => file.close(),
    };
  }

  private async assertProtectedReadPath(path: string): Promise<void> {
    const protectedRoot = await realpath(this.agentDataCanonicalRoot).catch(
      () => this.agentDataCanonicalRoot
    );
    const difference = relative(protectedRoot, path);
    if (
      difference === "" ||
      difference === ".." ||
      difference.startsWith(`..${sep}`) ||
      isAbsolute(difference)
    ) {
      return;
    }
    const restriction = protectedAgentDataPath(difference.split(sep).join("/"));
    if (restriction === "private") {
      throw new Error(`Read is not allowed for protected agent-data path: ${path}`);
    }
    if (restriction === "database") {
      throw new Error(`Read does not expose live agent SQLite files: ${path}`);
    }
  }

  private async assertAgentReadable(path: string): Promise<void> {
    const identity = agentProcessIdentity();
    if (identity.uid === undefined || identity.gid === undefined) return;
    await new Promise<void>((resolveAccess, reject) => {
      const child = spawn("/usr/bin/test", ["-r", path], {
        ...identity,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolveAccess();
        else reject(Object.assign(new Error(`Read is not allowed for an agent-inaccessible path: ${path}`), { code: "EACCES" }));
      });
    });
  }

  private async pdfText(bytes: Buffer): Promise<string> {
    return new Promise<string>((resolveText, reject) => {
      const child = spawn("pdftotext", ["-", "-"], {
        env: sanitizedAgentEnvironment(process.env),
        ...agentProcessIdentity(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(bytes);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolveText(Buffer.concat(stdout).toString("utf8"));
        else reject(new Error(Buffer.concat(stderr).toString("utf8") || "PDF conversion failed"));
      });
    });
  }

  private async hostFetch<T = unknown>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    parse?: (value: unknown) => T,
    timeoutMs = 120_000
  ): Promise<T> {
    const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
    const machineId = (body as {machineId?:string})?.machineId;
    const bridgeUrl = await this.machines?.endpoint(machineId,signal) ?? this.hostBridgeUrl;
    const response = await fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error) => {
      throw new Error(
        `The physical-host bridge is offline. Open the OpenTeam desktop and verify its bridge token. ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const value: unknown = await response.json().catch(() => ({}));
    const envelope =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    if (!response.ok) {
      throw new Error(
        typeof envelope.error === "string"
          ? envelope.error
          : `Physical-host bridge rejected the call (${response.status})`
      );
    }
    return parse ? parse(value) : (value as T);
  }
}
