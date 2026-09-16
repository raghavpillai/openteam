import { MachineDirectory } from "./machine-directory";
import { Readable } from "node:stream";
import { agentReadStream, agentWriteStream } from "./agent-file-stream";
import { formatBytes2 } from "@openteam/contracts/reference-formatters";
import { renderReadText } from "@openteam/contracts/read-output";
import { boundToolImage } from "./runtime/image-input";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
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
  HOST_BRIDGE_PATHS,
  HOST_INLINE_OUTPUT_MAX_BYTES,
  HOST_TRANSFER_MAX_BYTES,
  type HostApprovalRequest,
  type HostApprovalTokens,
  type HostAutoReviewRequest,
  type HostMachine,
  type HostPermissionUpdateRequest,
  type HostReadRequest,
  type HostShellRequest,
  imageMimeTypeForPath,
  isHostApprovalRequest,
  parseHostMachinesResponse,
  parseHostReadResponse,
  parseHostShellResponse,
  parseShellAwaitResponse,
} from "@openteam/contracts/service-protocol";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";
import { agentFileIO } from "./agent-file-io";

const DEFAULT_BLOCK_MS = 30_000;
const PROTECTED_AGENT_DATA_TREES = new Set([
  "agents",
  "managed-skills",
  "plugin-skills",
  "plugins",
  "projects",
  "user-memory",
  "workflows",
]);
const SQLITE_FILE = /^(?:store|conversation-blobs)\.db(?:-(?:shm|wal))?$/;

export const sanitizedShellEnvironment = (
  source: NodeJS.ProcessEnv,
  workingDirectory: string
): NodeJS.ProcessEnv => sanitizedAgentEnvironment(source, { PWD: workingDirectory });

const bounded = (value: string): string =>
  value.length <= HOST_INLINE_OUTPUT_MAX_BYTES
    ? value
    : `${value.slice(0, HOST_INLINE_OUTPUT_MAX_BYTES)}\n… output truncated; complete output is in the terminal file`;

const localPath = (path: string, cwd: string): string =>
  isAbsolute(path) ? resolve(path) : resolve(cwd, path);

const textResult = (
  text: string,
  details: Record<string, unknown> = {}
): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text }],
  details,
});

export type { HostApprovalRequest, HostApprovalTokens, HostMachine };
export interface CopyFileInput { computer_path?: string; box_path?: string; machineId: string }

export class HostApprovalRequiredError extends Error {
  constructor(readonly approval: HostApprovalRequest) {
    super("User approval is required");
    this.name = "HostApprovalRequiredError";
  }
}

export class NativeToolExecutor {
  /** Private supervisor transport. Never return this envelope from a model tool. */
  desktopCapability(tool: string, botId: string, args: unknown, signal?: AbortSignal, callId?: string): Promise<Record<string, any>> {
    return this.hostFetch(HOST_BRIDGE_PATHS.capabilities, { tool, botId, arguments: args, callId }, signal, undefined, 15 * 60_000);
  }
  private readonly shellJobs: ShellJobRegistry;
  private readonly terminalDir: string;
  private readonly hostBridgeUrl: string;
  private readonly machines?: MachineDirectory;
  private readonly controlToken: string;
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

  async shell(
    input: ShellToolInput,
    cwd: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
    scope = "",
    routing: { channelId?: string; automationRunId?: string; secrets?: string[]; secretEnvironment?: Record<string, string> } = {}
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    signal?.throwIfAborted();
    const workingDirectory = localPath(input.working_directory ?? cwd, cwd);
    const directory = await stat(workingDirectory);
    if (!directory.isDirectory()) throw new Error(`Not a directory: ${workingDirectory}`);
    await mkdir(this.terminalDir, { recursive: true });
    const savedEnvironment = await loadShellEnvironment(this.terminalDir, scope, environment ?? process.env, environment);

    const shellId = String(randomInt(100000, 2147483647));
    const outputPath = resolve(this.terminalDir, `${shellId}.log`);
    const outputFile = createWriteStream(outputPath, {
      flags: "wx",
      mode: 0o600,
    });
    const startedAt = Date.now();
    const header = redactSecrets(`command: ${input.command}\nworking_directory: ${workingDirectory}\nstarted_at: ${new Date(startedAt).toISOString()}\n\n`, routing.secrets ?? []);
    outputFile.write(header);

    const environmentCapture = createShellEnvironmentCapture(dirname(savedEnvironment.path));
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", `${SHELL_ENVIRONMENT_CAPTURE}\n${input.command}`], {
      cwd: workingDirectory,
      env: { ...sanitizedShellEnvironment(savedEnvironment.environment, workingDirectory), ...routing.secretEnvironment },
      ...agentProcessIdentity(),
      stdio: ["ignore", "pipe", "pipe", environmentCapture.fd],
    });
    environmentCapture.closeParent();
    const chunks: Buffer[] = [];
    const job = this.shellJobs.start({
      id: shellId,
      scope,
      outputPath,
      outputOffset: Buffer.byteLength(header),
      startedAt,
      pid: child.pid,
      channelId: routing.channelId,
      automationRunId: routing.automationRunId,
    });
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      outputFile.write(chunk, (error) => {
        if (!error) job.outputWritten(chunk.length);
      });
      if (bytes < HOST_INLINE_OUTPUT_MAX_BYTES) {
        const remaining = HOST_INLINE_OUTPUT_MAX_BYTES - bytes;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
      }
    };
    const stdoutRedactor = new SecretRedactor(routing.secrets ?? []);
    const stderrRedactor = new SecretRedactor(routing.secrets ?? []);
    child.stdout!.on("data", chunk => collect(stdoutRedactor.write(chunk)));
    child.stderr!.on("data", chunk => collect(stderrRedactor.write(chunk)));
    child.stdout!.once("end", () => collect(stdoutRedactor.end()));
    child.stderr!.once("end", () => collect(stderrRedactor.end()));

    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let processError: Error | undefined;
    const completion = new Promise<number | null>((resolveCompletion) => {
      let closed = false;
      let settled = false;
      let exitCode: number | null = null;
      const finish = async () => {
        if (settled) return;
        settled = true;
        {
          try { await environmentCapture.persist(savedEnvironment.path, Object.keys(routing.secretEnvironment ?? {})); }
          catch (error) { processError = error instanceof Error ? error : new Error("Could not persist shell environment"); }
        }
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
      child.once("close", (code) => {
        closed = true;
        exitCode = code;
        if (outputFile.destroyed) {
          finish();
          return;
        }
        const elapsedMs = Date.now() - startedAt;
        outputFile.end(
          `\n\nstatus: completed\nexit_code: ${code ?? "null"}\nelapsed_ms: ${elapsedMs}\n`,
          finish
        );
      });
    });

    const blockMs = Math.max(0, input.block_until_ms ?? DEFAULT_BLOCK_MS);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      completion.then((exitCode) => ({ done: true as const, exitCode })),
      new Promise<{ done: false }>(
        (resolveTimeout) => (timeoutId = setTimeout(() => resolveTimeout({ done: false }), blockMs))
      ),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abort);

    if (!completed.done) {
      this.shellJobs.markBackground(shellId);
      void completion.catch(() => undefined);
      return textResult(
        `Background command started successfully.\nShell ID: ${shellId}\nPID: ${child.pid}\nCommand: ${redactSecrets(input.command, routing.secrets ?? [])}\nOutput will be written to ${outputPath}. Don't mention Shell ID to the user.`,
        { shellId, status: "running", outputPath }
      );
    }

    if (processError) throw processError;
    const output = bounded(Buffer.concat(chunks).toString("utf8"));
    return textResult(
      `Exit code: ${completed.exitCode ?? "null"}\n\nCommand output:\n\n\`\`\`\n${output}\n\`\`\`\n\nCommand completed in ${Date.now() - startedAt} ms.\n\nShell state (cwd, env vars) persists for subsequent calls.`,
      {
        shellId,
        status: "completed",
        exitCode: completed.exitCode,
        outputPath,
        elapsedMs: Date.now() - startedAt,
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
    signal?: AbortSignal,
    approvals: HostApprovalTokens = {}
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const request = { ...input, ...approvals } satisfies HostShellRequest;
    const response = await this.hostFetch(
      HOST_BRIDGE_PATHS.shell,
      request,
      signal,
      parseHostShellResponse
    );
    return textResult(response.output || JSON.stringify(response), {
      ...response,
    });
  }

  async externalRead(
    input: ReadToolInput,
    signal?: AbortSignal,
    approvals: HostApprovalTokens = {}
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const request = { ...input, ...approvals } satisfies HostReadRequest;
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

  async copyFile(direction: "toBox" | "fromBox", input: CopyFileInput, cwd: string, signal?: AbortSignal, approvals: HostApprovalTokens = {}) {
    const toBox = direction === "toBox";
    const boxPath = localPath(input.box_path ?? `uploads/${basename(input.computer_path!)}`, cwd);
    const computerPath = input.computer_path ?? basename(boxPath);
    // Use the agent UID for actual I/O and retain the extra protected-data fence.
    if (!toBox) await this.assertProtectedReadPath(await realpath(boxPath));
    const sourceSize = toBox ? undefined : (await stat(boxPath)).size;
    const permit = await this.hostFetch<{ transferId: string; path: string }>(HOST_BRIDGE_PATHS.transfer, {
      direction: toBox ? "read" : "write", path: computerPath, machineId: input.machineId,
      ...(sourceSize !== undefined ? { bytes: sourceSize } : {}), ...approvals,
    }, signal);
    const source = toBox ? undefined : agentReadStream(boxPath, signal);
    let size=sourceSize ?? 0;
    try {
      const bridgeUrl = await this.machines?.endpoint(input.machineId,signal) ?? this.hostBridgeUrl;
      const response = await fetch(`${bridgeUrl}${HOST_BRIDGE_PATHS.transfer}/${encodeURIComponent(permit.transferId)}`, {
        method: toBox ? "GET" : "PUT", headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/octet-stream" },
        ...(source ? { body: Readable.toWeb(source.stream) as unknown as ReadableStream<Uint8Array>, duplex:"half" } : {}), signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error ?? `File transfer failed (${response.status})`);
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

  async autoReviewTask(
    input: TaskInput,
    signal?: AbortSignal,
    approvals: HostApprovalTokens = {}
  ): Promise<void> {
    const task = `Run a task on OpenTeam's computer: “${input.prompt}”`;
    const request = {
      surface: "subagentLaunch",
      summary: task,
      target: input.subagent_type ?? "generalPurpose",
      arguments: {
        task,
        prompt: input.prompt,
        description: input.description,
        subagent_type: input.subagent_type ?? "generalPurpose",
        ...(input.model ? { model: input.model } : {}),
        ...(input.resume ? { resume: input.resume } : {}),
        ...(input.file_attachments?.length ? { file_attachments: input.file_attachments } : {}),
        ...(input.run_in_background !== undefined
          ? { run_in_background: input.run_in_background }
          : {}),
      },
      ...approvals,
    } satisfies HostAutoReviewRequest;
    await this.hostFetch(HOST_BRIDGE_PATHS.autoReview, request, signal);
  }

  async setLocalToolPermission(
    machineId: string,
    localToolPermission: HostMachine["localToolPermission"],
    signal?: AbortSignal
  ): Promise<void> {
    const request = { machineId, localToolPermission } satisfies HostPermissionUpdateRequest;
    await this.hostFetch(HOST_BRIDGE_PATHS.permissionUpdate, request, signal);
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
    // expose canonical numeric/legacy UUID log paths, never adjacent files or symlink escapes.
    const terminalRoot = await realpath(this.terminalDir).catch(() => undefined);
    const terminalLog =
      terminalRoot !== undefined &&
      /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.log$/i.test(
        relative(terminalRoot, canonical)
      );
    if (!terminalLog) await this.assertAgentReadable(canonical);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error(`Not a file: ${path}`);

    const mimeType = imageMimeTypeForPath(canonical);
    if (mimeType) {
      const data = await readFile(canonical);
      return {
        content: [
          { type: "text", text: `Image file: ${canonical}` },
          await boundToolImage(data, mimeType),
        ],
        details: { path: canonical, bytes: data.length, mimeType },
      };
    }

    const raw =
      extname(canonical).toLowerCase() === ".pdf"
        ? await this.pdfText(canonical)
        : await readFile(canonical, "utf8");
    const { text, ...details } = renderReadText(raw, offset, limit, metadata.size);
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
    const [tree] = difference.split(sep);
    if (!tree || !PROTECTED_AGENT_DATA_TREES.has(tree)) {
      throw new Error(`Read is not allowed for protected agent-data path: ${path}`);
    }
    if (SQLITE_FILE.test(basename(path))) {
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

  private async pdfText(path: string): Promise<string> {
    return new Promise<string>((resolveText, reject) => {
      const child = spawn("pdftotext", [path, "-"], {
        env: sanitizedAgentEnvironment(process.env),
        ...agentProcessIdentity(),
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      if (
        response.status === 409 &&
        envelope.error === "approval_required" &&
        isHostApprovalRequest(envelope.approval)
      ) {
        throw new HostApprovalRequiredError(envelope.approval);
      }
      throw new Error(
        typeof envelope.error === "string"
          ? envelope.error
          : `Physical-host bridge rejected the call (${response.status})`
      );
    }
    return parse ? parse(value) : (value as T);
  }
}
