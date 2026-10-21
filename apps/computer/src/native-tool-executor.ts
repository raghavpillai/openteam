import { MachineDirectory } from "./machine-directory";
import type { TaskConfiguration } from "@openteam/contracts/task-configuration";
import { Readable } from "node:stream";
import { agentReadStream, agentWriteStream } from "./agent-file-stream";
import { formatBytes2 } from "@openteam/contracts/reference-formatters";
import { renderReadText, renderPdfReadText } from "@openteam/contracts/read-output";
import { boundToolImage } from "./runtime/image-input";
import { decodeReadableText } from "./read-text";
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
  shellUserBackgroundedIntro,
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
import { spawnAgentProcess as spawn, agentProcessIdentity, agentProcessGroupSignaler, sanitizedAgentEnvironment } from "./agent-process";
import { agentFileIO } from "./agent-file-io";
import { protectedAgentDataPath } from "@openteam/contracts/agent-file-access";

const DEFAULT_BLOCK_MS = 30_000;
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
    const machineId = await this.machines?.preferred(botId, channelId, signal);
    return this.hostFetch(HOST_BRIDGE_PATHS.capabilities, { tool, botId, arguments: args, callId, machineId }, signal, undefined, 15 * 60_000);
  }
  private readonly shellJobs: ShellJobRegistry;
  private readonly terminalDir: string;
  private readonly hostBridgeUrl: string;
  private readonly machines?: MachineDirectory;
  private readonly controlToken: string;
  private readonly serverUrl?: string;
  private readonly agentDataCanonicalRoot: string;

  constructor(options: {
    agentDir: string;
    controlToken: string;
    hostBridgeUrl?: string;
    serverUrl?: string;
    agentDataCanonicalRoot?: string;
    onShellComplete?: (job: ShellCompletion) => Promise<void>;
  }) {
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
    routing: { channelId?: string; automationRunId?: string; secrets?: string[]; secretEnvironment?: Record<string, string>; background?: AbortSignal } = {}
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
    const savedEnvironment = await loadShellEnvironment(this.terminalDir, scope, environment ?? process.env, environment);
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
      env: { ...sanitizedShellEnvironment(savedEnvironment.environment, workingDirectory), ...routing.secretEnvironment, OPENTEAM_DESKTOP_ID: environment?.OPENTEAM_DESKTOP_ID },
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
    const abort = () => {
      abortedAt ??= Date.now();
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 500);
    };
    child.once("close", () => { if (killTimer) clearTimeout(killTimer); });
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
        clearInterval(headerTimer);
        try { exitDirectory = (await environmentCapture.persist(savedEnvironment.path, Object.keys(routing.secretEnvironment ?? {}), savedEnvironment.environment))?.PWD; }
        catch (error) { environmentError = error instanceof Error ? error : new Error("Could not persist shell environment"); }
        await rewriteHeader(abortedAt !== undefined ? "aborted" : exitCode === 0 ? "succeeded" : "failed");
        // A command that ran to completion is reported as such even if its shell
        // state could not be saved; AwaitShell and the completion notice show its exit.
        job.finish(exitCode, processError?.message);
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
    let onBackground: (() => void) | undefined;
    let completed = await Promise.race([
      completion.then((exitCode) => ({ done: true as const, exitCode })),
      new Promise<{ done: false; manual: false }>(
        (resolveTimeout) => (timeoutId = setTimeout(() => resolveTimeout({ done: false, manual: false }), blockMs))
      ),
      // A new user message moves a running foreground command to the background.
      new Promise<{ done: false; manual: true }>((resolveBackground) => {
        if (!routing.background) return;
        onBackground = () => resolveBackground({ done: false, manual: true });
        if (routing.background.aborted) onBackground();
        else routing.background.addEventListener("abort", onBackground, { once: true });
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (onBackground) routing.background?.removeEventListener("abort", onBackground);
    // A stopped command is being killed; report its interruption, not a backgrounding.
    if (!completed.done && abortedAt !== undefined) completed = { done: true, exitCode: await completion };
    signal?.removeEventListener("abort", abort);

    if (!completed.done) {
      this.shellJobs.markBackground(shellId);
      void completion.catch(() => undefined);
      const details = { shellId, status: "running", outputPath };
      if (blockMs === 0 && !completed.manual)
        return textResult(formatShellStartedResult({ shellId, pid: child.pid, command, outputPath }), details);
      return textResult(formatShellBackgroundedResult({
        intro: completed.manual ? shellUserBackgroundedIntro(Date.now() - startedAt) : shellTimedOutIntro(blockMs),
        shellId,
        pid: child.pid,
        outputPath,
        partial: output.excerpt(),
      }), completed.manual ? { ...details, backgroundedBy: "user_message" } : details);
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
    try { return await this.readLocal(localPath(input.path, cwd), input.offset, input.limit); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...textResult("Error: File not found"), isError: true } as AgentToolResult<Record<string, unknown>>;
      throw error;
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
          { type: "text", text: `Host file: ${response.path}` },
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
    return textResult(JSON.stringify({ machines: response.machines.map(machine => ({ machineId:machine.machineId, label:machine.label, connected:(machine as HostMachine & {connected?:boolean}).connected ?? true })) }, null, 2), {
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
    if (!metadata.isFile()) throw new Error(`Not a file: ${path}`);
    let bytes: Buffer;
    if (terminalLog) {
      // Supervisor-owned terminal logs are the sole privileged-read exception.
      // Pin the descriptor and recheck its actual target before returning bytes.
      const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const actual = await realpath(process.platform === "linux" ? `/proc/self/fd/${file.fd}` : `/dev/fd/${file.fd}`);
        await this.assertProtectedReadPath(actual);
        if (dirname(actual) !== terminalRoot || !TERMINAL_LOG_NAME.test(basename(actual)))
          throw new Error("Read terminal log target changed");
        const pinned = await file.stat();
        if (!pinned.isFile() || pinned.size > HOST_TRANSFER_MAX_BYTES)
          throw new Error("Source must be a regular file within the transfer size limit");
        bytes = await file.readFile();
      } finally { await file.close(); }
    } else {
      const protectedRoot = await realpath(this.agentDataCanonicalRoot).catch(() => this.agentDataCanonicalRoot);
      bytes = await agentFileIO("read", canonical, undefined, { protectedRoot });
    }
    const plainText = decodeReadableText(bytes);

    const mimeType = imageMimeTypeForPath(canonical);
    if (mimeType && plainText === undefined) {
      const data = bytes;
      return {
        content: [
          { type: "text", text: `Image file: ${canonical}` },
          await boundToolImage(data, mimeType),
        ],
        details: { path: canonical, bytes: data.length, mimeType },
      };
    }

    let raw: string;
    if (extname(canonical).toLowerCase() === ".pdf") {
      raw = await this.pdfText(bytes);
    } else {
      if (plainText === undefined) {
        throw new Error(`Binary files of type ${extname(canonical) || "unknown"} are not supported by the read executor`);
      }
      raw = plainText;
    }
    const isPdf = extname(canonical).toLowerCase() === ".pdf";
    const { text, ...details } = (isPdf ? renderPdfReadText : renderReadText)(raw, offset, limit, bytes.length);
    return textResult(text, { path: canonical, ...details });
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
        else reject(new Error(`Read is not allowed for an agent-inaccessible path: ${path}`));
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
