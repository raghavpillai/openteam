import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ReadToolInput, ShellToolInput, TaskInput } from "@openteam/contracts";
import {
  HOST_BRIDGE_PATHS,
  HOST_INLINE_OUTPUT_MAX_BYTES,
  HOST_READ_MAX_BYTES,
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
} from "@openteam/contracts/service-protocol";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";

const DEFAULT_BLOCK_MS = 30_000;
const PROTECTED_AGENT_DATA_TREES = new Set([
  "agents",
  "managed-skills",
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

export class HostApprovalRequiredError extends Error {
  constructor(readonly approval: HostApprovalRequest) {
    super("User approval is required");
    this.name = "HostApprovalRequiredError";
  }
}

export class NativeToolExecutor {
  private readonly terminalDir: string;
  private readonly hostBridgeUrl: string;
  private readonly controlToken: string;
  private readonly agentDataCanonicalRoot: string;

  constructor(options: {
    agentDir: string;
    controlToken: string;
    hostBridgeUrl?: string;
    agentDataCanonicalRoot?: string;
  }) {
    this.terminalDir = resolve(options.agentDir, "terminals");
    this.controlToken = options.controlToken;
    this.hostBridgeUrl =
      options.hostBridgeUrl ??
      process.env.OPENTEAM_HOST_BRIDGE_URL ??
      "http://host.docker.internal:8791";
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
    environment?: NodeJS.ProcessEnv
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const workingDirectory = localPath(input.working_directory ?? cwd, cwd);
    const directory = await stat(workingDirectory);
    if (!directory.isDirectory()) throw new Error(`Not a directory: ${workingDirectory}`);
    await mkdir(this.terminalDir, { recursive: true });

    const shellId = crypto.randomUUID();
    const outputPath = resolve(this.terminalDir, `${shellId}.log`);
    const outputFile = createWriteStream(outputPath, {
      flags: "wx",
      mode: 0o600,
    });
    const startedAt = Date.now();
    outputFile.write(
      `command: ${input.command}\nworking_directory: ${workingDirectory}\nstarted_at: ${new Date(startedAt).toISOString()}\n\n`
    );

    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", input.command], {
      cwd: workingDirectory,
      env: sanitizedShellEnvironment(environment ?? process.env, workingDirectory),
      ...agentProcessIdentity(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      outputFile.write(chunk);
      if (bytes < HOST_INLINE_OUTPUT_MAX_BYTES) {
        const remaining = HOST_INLINE_OUTPUT_MAX_BYTES - bytes;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const completion = new Promise<number | null>((resolveCompletion, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        const elapsedMs = Date.now() - startedAt;
        outputFile.end(
          `\n\nstatus: completed\nexit_code: ${code ?? "null"}\nelapsed_ms: ${elapsedMs}\n`,
          () => resolveCompletion(code)
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
      void completion.catch(() => undefined);
      return textResult(
        JSON.stringify({
          shell_id: shellId,
          status: "running",
          output: bounded(Buffer.concat(chunks).toString("utf8")),
          output_path: outputPath,
          elapsed_ms: Date.now() - startedAt,
        }),
        { shellId, status: "running", outputPath }
      );
    }

    const output = bounded(Buffer.concat(chunks).toString("utf8"));
    return textResult(
      output || `(command completed with exit code ${completed.exitCode ?? "null"})`,
      {
        shellId,
        status: "completed",
        exitCode: completed.exitCode,
        outputPath,
        elapsedMs: Date.now() - startedAt,
      }
    );
  }

  async read(input: ReadToolInput, cwd: string): Promise<AgentToolResult<Record<string, unknown>>> {
    return this.readLocal(localPath(input.path, cwd), input.offset, input.limit);
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
          { type: "image", data: response.data, mimeType: response.mimeType },
        ],
        details: { path: response.path, host: true },
      };
    }
    return textResult(response.text ?? "", {
      path: response.path,
      lines: response.lines ?? null,
      host: true,
    });
  }

  async listMachines(signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
    const response = await this.hostFetch(
      HOST_BRIDGE_PATHS.machines,
      {},
      signal,
      parseHostMachinesResponse
    );
    return textResult(JSON.stringify(response), {
      machines: response.machines,
    });
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
    await this.assertAgentReadable(canonical);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error(`Not a file: ${path}`);
    if (metadata.size > HOST_READ_MAX_BYTES) {
      throw new Error(`File exceeds the ${HOST_READ_MAX_BYTES} byte read limit`);
    }
    const mimeType = imageMimeTypeForPath(canonical);
    if (mimeType) {
      const data = await readFile(canonical);
      return {
        content: [
          { type: "text", text: `Image file: ${canonical}` },
          { type: "image", data: data.toString("base64"), mimeType },
        ],
        details: { path: canonical, bytes: data.length, mimeType },
      };
    }

    const raw =
      extname(canonical).toLowerCase() === ".pdf"
        ? await this.pdfText(canonical)
        : await readFile(canonical, "utf8");
    const lines = raw.split(/\r?\n/);
    const start =
      offset === undefined
        ? 0
        : offset < 0
          ? Math.max(0, lines.length + offset)
          : Math.max(0, offset - 1);
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    const selected = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`);
    return textResult(bounded(selected.join("\n")), {
      path: canonical,
      totalLines: lines.length,
      offset: start + 1,
      lines: selected.length,
      truncated: end < lines.length,
    });
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
    parse?: (value: unknown) => T
  ): Promise<T> {
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetch(`${this.hostBridgeUrl}${path}`, {
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
