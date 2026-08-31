import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { listenForHostBridge } from "./host-bridge-listener";
import {
  type AutoReviewMode,
  type AutoReviewPromptDecision,
  type AutoReviewResult,
  authorizeAutoReviewAction,
  authorizeHostAction,
  type HostAction,
  type HostPermissionDependencies,
  type LocalPromptDecision,
} from "./host-permissions";
import type { PermissionSettingsStore } from "./permission-settings";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_BYTES = 100_000;

interface ShellRequest {
  command?: unknown;
  description?: unknown;
  working_directory?: unknown;
  block_until_ms?: unknown;
  machineId?: unknown;
  localApproval?: unknown;
  autoReviewApproval?: unknown;
}

interface ReadRequest {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
  machineId?: unknown;
  localApproval?: unknown;
  autoReviewApproval?: unknown;
}

interface PermissionUpdateRequest {
  machineId?: unknown;
  localToolPermission?: unknown;
}

interface AutoReviewRequest extends ApprovalCarrier {
  surface?: unknown;
  summary?: unknown;
  target?: unknown;
  command?: unknown;
  arguments?: unknown;
}

interface ApprovalCarrier {
  localApproval?: unknown;
  autoReviewApproval?: unknown;
}

interface HostApprovalRequest {
  gate: "local" | "auto-review";
  requestMethod: "openbot/localTool" | "openbot/autoReview";
  details: Record<string, unknown>;
}

class HostApprovalRequired extends Error {
  constructor(readonly approval: HostApprovalRequest) {
    super("User approval is required");
    this.name = "HostApprovalRequired";
  }
}

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const authorized = (request: IncomingMessage, token: string): boolean => {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const imageMime = (path: string): string | null => {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
};

const localApprovalDecision = (
  input: ApprovalCarrier,
  action: HostAction,
  machineId: string,
  machineLabel: string
): LocalPromptDecision => {
  if (["allow-once", "always"].includes(String(input.localApproval))) {
    return input.localApproval as LocalPromptDecision;
  }
  const shell = action.surface === "hostShell";
  throw new HostApprovalRequired({
    gate: "local",
    requestMethod: "openbot/localTool",
    details: {
      type: "localTool",
      gate: "local",
      action: shell ? "runCommand" : "readFile",
      toolName: shell ? "Shell" : "Read",
      machineId,
      machineLabel,
      effect: shell
        ? "Allow OpenBot and all Bots to run commands on your local computer?"
        : "Allow OpenBot and all Bots to read files on your local computer?",
      summary: action.summary,
      arguments: {
        ...(shell
          ? { command: action.command, working_directory: action.target }
          : { path: action.target }),
        ...(action.arguments ?? {}),
        machineId,
      },
      supportsAlwaysAllow: true,
      supportsNever: true,
    },
  });
};

const autoReviewSummary = (action: HostAction): string => {
  if (action.surface !== "hostShell" && action.surface !== "hostRead") return action.summary;

  const description = action.summary
    .trim()
    .replace(/\s+on (?:this|the|your local) computer\.?$/i, "")
    .trim();
  if (action.surface === "hostShell") {
    const commandSummary = description || "Run a command";
    return action.target
      ? `${commandSummary} on your local computer from ${action.target}`
      : `${commandSummary} on your local computer`;
  }

  const readSummary = description || "Read a file";
  return action.target
    ? `${readSummary} on your local computer from ${action.target}`
    : `${readSummary} on your local computer`;
};

const autoReviewApprovalDecision = (
  input: ApprovalCarrier,
  action: HostAction,
  review: AutoReviewResult,
  machineId: string,
  machineLabel: string
): AutoReviewPromptDecision => {
  if (["allow-once", "always"].includes(String(input.autoReviewApproval))) {
    return input.autoReviewApproval as AutoReviewPromptDecision;
  }
  const proposedRule =
    review.proposedRule ??
    (action.surface === "hostShell"
      ? `Allow this exact host command: ${action.command ?? action.target}`
      : action.surface === "hostRead"
        ? `Allow reading this exact host file: ${action.target}`
        : `Allow this exact ${action.surface} action: ${action.summary}`);
  const shell = action.surface === "hostShell";
  const read = action.surface === "hostRead";
  throw new HostApprovalRequired({
    gate: "auto-review",
    requestMethod: "openbot/autoReview",
    details: {
      type: "autoReview",
      gate: "auto-review",
      action: shell ? "runCommand" : read ? "readFile" : "runTask",
      toolName: shell ? "Shell" : read ? "Read" : "Task",
      machineId,
      machineLabel,
      effect: "Auto Review requires your approval before this action can run.",
      summary: autoReviewSummary(action),
      reason: review.reason,
      proposedRule,
      arguments: {
        ...(shell
          ? { command: action.command, working_directory: action.target }
          : read
            ? { path: action.target }
            : {}),
        ...(action.arguments ?? {}),
        ...(shell || read ? { machineId } : {}),
      },
      supportsAlwaysAllow: true,
    },
  });
};

const pdfText = (path: string): Promise<string> =>
  new Promise((resolveText, reject) => {
    const child = spawn("pdftotext", [path, "-"], {
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

const executeRead = async (input: ReadRequest) => {
  if (typeof input.path !== "string" || !isAbsolute(input.path)) {
    throw new Error("ExternalRead requires an absolute path");
  }
  const path = resolve(input.path);
  await access(path);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("ExternalRead path is not a file");
  if (metadata.size > MAX_READ_BYTES) throw new Error("ExternalRead file exceeds 10 MiB");
  const mimeType = imageMime(path);
  if (mimeType) {
    return {
      kind: "image" as const,
      path,
      mimeType,
      data: (await readFile(path)).toString("base64"),
    };
  }
  const raw =
    extname(path).toLowerCase() === ".pdf" ? await pdfText(path) : await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const offset =
    typeof input.offset === "number" && Number.isInteger(input.offset) ? input.offset : undefined;
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
      ? input.limit
      : undefined;
  const start =
    offset === undefined
      ? 0
      : offset < 0
        ? Math.max(0, lines.length + offset)
        : Math.max(0, offset - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  const text = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
  return {
    kind: "text" as const,
    path,
    text:
      text.length <= MAX_INLINE_BYTES ? text : `${text.slice(0, MAX_INLINE_BYTES)}\n… truncated`,
    lines: end - start,
  };
};

const executeShell = async (input: ShellRequest, terminalDir: string) => {
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
  if (!directory.isDirectory())
    throw new Error("ExternalShell working_directory is not a directory");
  await mkdir(terminalDir, { recursive: true });
  const shellId = crypto.randomUUID();
  const outputPath = resolve(terminalDir, `${shellId}.log`);
  const outputFile = createWriteStream(outputPath, {
    flags: "wx",
    mode: 0o600,
  });
  const startedAt = Date.now();
  outputFile.write(
    `command: ${input.command}\nworking_directory: ${workingDirectory}\nstarted_at: ${new Date(startedAt).toISOString()}\n\n`
  );
  const child = spawn(input.command, {
    cwd: workingDirectory,
    env: process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let size = 0;
  const collect = (chunk: Buffer) => {
    outputFile.write(chunk);
    if (size < MAX_INLINE_BYTES) {
      const remaining = MAX_INLINE_BYTES - size;
      chunks.push(chunk.subarray(0, remaining));
      size += Math.min(remaining, chunk.length);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const completion = new Promise<number | null>((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      outputFile.end(
        `\n\nstatus: completed\nexit_code: ${code ?? "null"}\nelapsed_ms: ${Date.now() - startedAt}\n`
      );
      resolveCompletion(code);
    });
  });
  const requested = typeof input.block_until_ms === "number" ? input.block_until_ms : 30_000;
  const blockMs = Math.max(0, Math.min(7_140_000, requested));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    completion.then((exitCode) => ({ done: true as const, exitCode })),
    new Promise<{ done: false }>(
      (resolveTimeout) => (timeoutId = setTimeout(() => resolveTimeout({ done: false }), blockMs))
    ),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (!completed.done) void completion.catch(() => undefined);
  return {
    shell_id: shellId,
    status: completed.done ? ("completed" as const) : ("running" as const),
    exit_code: completed.done ? completed.exitCode : null,
    output: Buffer.concat(chunks).toString("utf8"),
    output_path: outputPath,
    elapsed_ms: Date.now() - startedAt,
  };
};

export const startHostBridge = (options: {
  token: string;
  port: number;
  terminalDir: string;
  permissionSettings: PermissionSettingsStore;
  autoReviewMode: AutoReviewMode;
  machineId?: string;
  machineLabel?: string;
  reviewAction: (
    action: HostAction,
    rules: { allowInstructions: string[]; blockInstructions: string[] }
  ) => Promise<AutoReviewResult>;
}): Promise<Server> => {
  const machineId = options.machineId ?? "this-computer";
  const defaultMachineLabel = options.machineLabel ?? hostname();
  const currentMachineLabel = async () =>
    (await options.permissionSettings.read()).machineLabel ?? defaultMachineLabel;
  const assertMachine = (supplied: unknown) => {
    if (supplied !== undefined && supplied !== machineId) {
      throw new Error(`Unknown local computer: ${String(supplied)}`);
    }
  };
  const dependencies = (
    input: ApprovalCarrier,
    machineLabel: string
  ): HostPermissionDependencies => ({
    settings: options.permissionSettings,
    mode: options.autoReviewMode,
    promptLocal: (candidate) =>
      Promise.resolve(localApprovalDecision(input, candidate, machineId, machineLabel)),
    review: options.reviewAction,
    promptAutoReview: (candidate, result) =>
      Promise.resolve(
        autoReviewApprovalDecision(input, candidate, result, machineId, machineLabel)
      ),
  });
  const authorize = async (action: HostAction, input: ApprovalCarrier) => {
    const machineLabel = await currentMachineLabel();
    return authorizeHostAction(action, dependencies(input, machineLabel));
  };
  const authorizeReviewOnly = async (action: HostAction, input: ApprovalCarrier) => {
    const machineLabel = await currentMachineLabel();
    return authorizeAutoReviewAction(action, dependencies(input, machineLabel));
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      return json(response, 200, { status: "ready" });
    }
    if (!authorized(request, options.token)) return json(response, 401, { error: "unauthorized" });
    try {
      if (request.method === "POST" && request.url === "/v1/machines") {
        const settings = await options.permissionSettings.read();
        return json(response, 200, {
          machines: [
            {
              machineId,
              label: settings.machineLabel ?? defaultMachineLabel,
              localToolPermission: settings.localToolPermission,
            },
          ],
        });
      }
      if (request.method === "POST" && request.url === "/v1/permissions/update") {
        const input = (await body(request)) as PermissionUpdateRequest;
        assertMachine(input.machineId);
        if (!["always", "ask", "never"].includes(String(input.localToolPermission))) {
          throw new Error("Invalid local computer permission");
        }
        const settings = await options.permissionSettings.update({
          localToolPermission: input.localToolPermission as "always" | "ask" | "never",
        });
        return json(response, 200, {
          machineId,
          label: settings.machineLabel ?? defaultMachineLabel,
          localToolPermission: settings.localToolPermission,
        });
      }
      if (request.method === "POST" && request.url === "/v1/auto-review") {
        const input = (await body(request)) as AutoReviewRequest;
        if (
          !["mcp", "computer", "automationWrite", "cloudAgent", "subagentLaunch"].includes(
            String(input.surface)
          ) ||
          typeof input.summary !== "string" ||
          !input.summary.trim() ||
          typeof input.target !== "string" ||
          !input.target.trim() ||
          (input.arguments !== undefined &&
            (!input.arguments ||
              typeof input.arguments !== "object" ||
              Array.isArray(input.arguments)))
        ) {
          throw new Error("Auto Review action is invalid");
        }
        const permission = await authorizeReviewOnly(
          {
            surface: input.surface as HostAction["surface"],
            summary: input.summary.trim().slice(0, 500),
            target: input.target.trim().slice(0, 4_000),
            ...(typeof input.command === "string"
              ? { command: input.command.slice(0, 4_000) }
              : {}),
            ...(input.arguments ? { arguments: input.arguments as Record<string, unknown> } : {}),
          },
          input
        );
        if (!permission.allowed) {
          return json(response, 403, {
            error: permission.reason ?? "Auto Review rejected this action",
          });
        }
        return json(response, 200, { allowed: true });
      }
      if (request.method === "POST" && request.url === "/v1/read") {
        const input = (await body(request)) as ReadRequest;
        assertMachine(input.machineId);
        if (typeof input.path !== "string") throw new Error("ExternalRead path is required");
        const permission = await authorize(
          {
            surface: "hostRead",
            summary: "Read a file on this computer",
            target: input.path,
            arguments: { offset: input.offset, limit: input.limit },
          },
          input
        );
        if (!permission.allowed) {
          const error =
            permission.gate === "local" &&
            permission.reason === "Local computer execution is disabled"
              ? "Local computer tools are disabled. Do not retry this action on the user's computer."
              : permission.reason;
          return json(response, 403, { error });
        }
        return json(response, 200, await executeRead(input));
      }
      if (request.method === "POST" && request.url === "/v1/shell") {
        const input = (await body(request)) as ShellRequest;
        assertMachine(input.machineId);
        if (typeof input.command !== "string") throw new Error("ExternalShell command is required");
        const permission = await authorize(
          {
            surface: "hostShell",
            summary:
              typeof input.description === "string" && input.description.trim()
                ? input.description.trim().slice(0, 500)
                : "Run a command on this computer",
            target: String(input.working_directory ?? process.cwd()),
            command: input.command,
            arguments: { blockUntilMs: input.block_until_ms },
          },
          input
        );
        if (!permission.allowed) {
          const error =
            permission.gate === "local" &&
            permission.reason === "Local computer execution is disabled"
              ? "Local computer tools are disabled. Do not retry this action on the user's computer."
              : permission.reason;
          return json(response, 403, { error });
        }
        return json(response, 200, await executeShell(input, options.terminalDir));
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HostApprovalRequired) {
        return json(response, 409, {
          error: "approval_required",
          approval: error.approval,
        });
      }
      return json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return listenForHostBridge(server, options.port);
};
