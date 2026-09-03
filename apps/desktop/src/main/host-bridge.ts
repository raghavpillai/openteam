import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import {
  HOST_BRIDGE_PATHS,
  parseHostAutoReviewRequest,
  parseHostPermissionUpdateRequest,
  parseHostReadRequest,
  parseHostShellRequest,
  type HostApprovalRequest,
  type HostApprovalTokens,
} from "@openteam/contracts/service-protocol";
import { listenForHostBridge } from "./host-bridge-listener";
import type { HostJobPayload } from "./host-job-protocol";
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

type ApprovalCarrier = HostApprovalTokens;

class HostApprovalRequired extends Error {
  constructor(readonly approval: HostApprovalRequest) {
    super("User approval is required");
    this.name = "HostApprovalRequired";
  }
}

const json = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
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
    requestMethod: "openteam/localTool",
    details: {
      type: "localTool",
      gate: "local",
      action: shell ? "runCommand" : "readFile",
      toolName: shell ? "Shell" : "Read",
      machineId,
      machineLabel,
      effect: shell
        ? "Allow OpenTeam and all Bots to run commands on your local computer?"
        : "Allow OpenTeam and all Bots to read files on your local computer?",
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
    requestMethod: "openteam/autoReview",
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
  runJob: (payload: HostJobPayload, signal?: AbortSignal) => Promise<unknown>;
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
    if (request.url === HOST_BRIDGE_PATHS.health && request.method === "GET") {
      return json(response, 200, { status: "ready" });
    }
    if (!authorized(request, options.token)) return json(response, 401, { error: "unauthorized" });

    const controller = new AbortController();
    const cancelOnDisconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", cancelOnDisconnect);

    try {
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.machines) {
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
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.permissionUpdate) {
        const input = parseHostPermissionUpdateRequest(await body(request));
        assertMachine(input.machineId);
        const settings = await options.permissionSettings.update({
          localToolPermission: input.localToolPermission,
        });
        return json(response, 200, {
          machineId,
          label: settings.machineLabel ?? defaultMachineLabel,
          localToolPermission: settings.localToolPermission,
        });
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.autoReview) {
        const input = parseHostAutoReviewRequest(await body(request));
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
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.read) {
        const input = parseHostReadRequest(await body(request));
        assertMachine(input.machineId);
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
        return json(
          response,
          200,
          await options.runJob({ kind: "read", input }, controller.signal)
        );
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.shell) {
        const input = parseHostShellRequest(await body(request));
        assertMachine(input.machineId);
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
        return json(
          response,
          200,
          await options.runJob(
            { kind: "shell", input, terminalDir: options.terminalDir },
            controller.signal
          )
        );
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HostApprovalRequired) {
        return json(response, 409, {
          error: "approval_required",
          approval: error.approval,
        });
      }
      if (!controller.signal.aborted) {
        return json(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      response.off("close", cancelOnDisconnect);
    }
  });
  return listenForHostBridge(server, options.port);
};
