import type { ComputerEvent } from "./index";
import { isRuntimeEngine } from "./inference";

export const COMPUTER_API_PATHS = {
  turns: "/v1/turns",
  approvalResolution: "/v1/approvals/resolve",
  inference: "/v1/infer",
  agentStores: "/v1/agent-stores",
  reconcileAgentStores: "/v1/agent-stores/reconcile",
  turnCancel: (runId: string) => `/v1/turns/${encodeURIComponent(runId)}/cancel`,
  turnSteer: (runId: string) => `/v1/turns/${encodeURIComponent(runId)}/steer`,
  agentStore: (ownerId: string) => `/v1/agent-stores/${encodeURIComponent(ownerId)}`,
} as const;

export const HOST_BRIDGE_PATHS = {
  health: "/health",
  shell: "/v1/shell",
  read: "/v1/read",
  machines: "/v1/machines",
  autoReview: "/v1/auto-review",
  permissionUpdate: "/v1/permissions/update",
} as const;

export const HOST_INLINE_OUTPUT_MAX_BYTES = 100_000;
export const HOST_READ_MAX_BYTES = 10 * 1024 * 1024;

export const imageMimeTypeForPath = (path: string): string | null => {
  const extension = /(?:^|\.)([^./]+)$/.exec(path.toLowerCase())?.[1];
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
};

export const parseComputerEvent = (value: unknown): ComputerEvent => {
  if (!isRecord(value)) throw new Error("Computer event must be an object");
  const type = requiredString(value.type, "Computer event type");
  switch (type) {
    case "session.attached":
      for (const field of [
        "runtimeEngine",
        "inferenceProvider",
        "contextSessionId",
        "sessionId",
        "sessionPath",
        "model",
      ] as const) {
        requiredString(value[field], field);
      }
      if (!isRuntimeEngine(value.runtimeEngine))
        throw new Error("Computer runtime engine is invalid");
      break;
    case "turn.started":
      requiredString(value.turnId, "turnId");
      break;
    case "input.delivered":
      for (const field of ["turnId", "inboxId", "clientMessageId"] as const) {
        requiredString(value[field], field);
      }
      break;
    case "item.started":
    case "item.completed":
      requiredString(value.turnId, "turnId");
      if (!("item" in value)) throw new Error("Computer event item is required");
      break;
    case "agent.delta":
      for (const field of ["turnId", "itemId", "delta"] as const) {
        requiredString(value[field], field);
      }
      break;
    case "approval.requested":
      for (const field of ["approvalId", "requestMethod", "turnId", "itemId"] as const) {
        requiredString(value[field], field);
      }
      break;
    case "context.state":
      requiredString(value.contextSessionId, "contextSessionId");
      if (typeof value.epoch !== "number" || !Array.isArray(value.archives)) {
        throw new Error("Computer context state is invalid");
      }
      break;
    case "compaction":
      for (const field of [
        "turnId",
        "contextSessionId",
        "compactionId",
        "reason",
        "prefixDigest",
        "summaryDigest",
        "startedAt",
        "completedAt",
      ] as const) {
        requiredString(value[field], field);
      }
      if (typeof value.epoch !== "number") throw new Error("Compaction epoch is invalid");
      break;
    case "runtime.error":
      requiredString(value.message, "message");
      if (typeof value.retrying !== "boolean") throw new Error("Runtime retrying is invalid");
      break;
    case "turn.completed":
      requiredString(value.turnId, "turnId");
      requiredString(value.status, "status");
      break;
    default:
      throw new Error(`Unsupported computer event: ${type}`);
  }
  return value as unknown as ComputerEvent;
};

export interface AgentDirectoryRecord {
  id: string;
  kind: "agent" | "group";
  name: string;
  description: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  hasStore: boolean;
  notifyOnAgentUpdates: boolean;
  hiddenFromSidebar: boolean;
  memberIds: string[];
}

export interface AgentDirectorySnapshot {
  agents: AgentDirectoryRecord[];
  revision: string;
}

export interface ComputerInferenceRequest {
  kind: "extraction" | "episode" | "synthesis" | "verification";
  instructions: string;
  prompt: string;
  timeoutMs: number;
  cwd?: string;
}

export interface ComputerInferenceResponse {
  text: string;
}

export const parseComputerInferenceRequest = (value: unknown): ComputerInferenceRequest => {
  const input = isRecord(value) ? value : {};
  if (!["extraction", "episode", "synthesis", "verification"].includes(String(input.kind))) {
    throw new Error("Inference kind is invalid");
  }
  const instructions = requiredString(input.instructions, "Inference instructions");
  const prompt = requiredString(input.prompt, "Inference prompt");
  if (!instructions.trim() || instructions.length > 20_000) {
    throw new Error("Inference instructions are invalid");
  }
  if (!prompt.trim() || prompt.length > 2_000_000) {
    throw new Error("Inference prompt is invalid");
  }
  if (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs)) {
    throw new Error("Inference timeout is invalid");
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    throw new Error("Inference cwd is invalid");
  }
  return {
    kind: input.kind as ComputerInferenceRequest["kind"],
    instructions,
    prompt,
    timeoutMs: input.timeoutMs,
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  };
};

export const parseAgentDirectorySnapshot = (value: unknown): AgentDirectorySnapshot => {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    throw new Error("Agent directory response is invalid");
  }
  const agents = value.agents.map((input) => {
    if (!isRecord(input) || (input.kind !== "agent" && input.kind !== "group")) {
      throw new Error("Agent directory record is invalid");
    }
    for (const field of ["id", "name", "description", "title"] as const) {
      requiredString(input[field], field);
    }
    if (
      typeof input.createdAt !== "number" ||
      typeof input.updatedAt !== "number" ||
      typeof input.hasStore !== "boolean" ||
      typeof input.notifyOnAgentUpdates !== "boolean" ||
      typeof input.hiddenFromSidebar !== "boolean" ||
      !Array.isArray(input.memberIds) ||
      input.memberIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("Agent directory record fields are invalid");
    }
    return input as unknown as AgentDirectoryRecord;
  });
  return {
    agents,
    revision: typeof value.revision === "string" ? value.revision : "",
  };
};

export type HostLocalToolPermission = "always" | "ask" | "never";
export type HostApprovalToken = "allow-once" | "always";

export interface HostApprovalTokens {
  localApproval?: HostApprovalToken;
  autoReviewApproval?: HostApprovalToken;
}

export interface HostApprovalRequest {
  gate: "local" | "auto-review";
  requestMethod: "openbot/localTool" | "openbot/autoReview";
  details: Record<string, unknown>;
}

export interface HostMachine {
  machineId: string;
  label: string;
  localToolPermission: HostLocalToolPermission;
}

export interface HostReadRequest extends HostApprovalTokens {
  path: string;
  offset?: number;
  limit?: number;
  machineId?: string;
}

export interface HostShellRequest extends HostApprovalTokens {
  command: string;
  working_directory?: string;
  block_until_ms?: number;
  description?: string;
  machineId?: string;
}

export interface HostPermissionUpdateRequest {
  machineId?: string;
  localToolPermission: HostLocalToolPermission;
}

export interface HostAutoReviewRequest extends HostApprovalTokens {
  surface: "mcp" | "computer" | "automationWrite" | "cloudAgent" | "subagentLaunch";
  summary: string;
  target: string;
  command?: string;
  arguments?: Record<string, unknown>;
}

export interface HostReadResponse {
  kind: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
  path: string;
  lines?: number;
}

export interface HostShellResponse {
  shell_id: string;
  status: "completed" | "running";
  exit_code: number | null;
  output: string;
  output_path: string;
  elapsed_ms: number;
}

export interface HostMachinesResponse {
  machines: HostMachine[];
}

const approvalTokens = (value: Record<string, unknown>): HostApprovalTokens => {
  const tokens: HostApprovalTokens = {};
  for (const field of ["localApproval", "autoReviewApproval"] as const) {
    const token = value[field];
    if (token !== undefined && token !== "allow-once" && token !== "always") {
      throw new Error(`${field} is invalid`);
    }
    if (token) tokens[field] = token;
  }
  return tokens;
};

export const parseHostShellRequest = (value: unknown): HostShellRequest => {
  const input = isRecord(value) ? value : {};
  const command = requiredString(input.command, "ExternalShell command");
  if (input.working_directory !== undefined && typeof input.working_directory !== "string") {
    throw new Error("ExternalShell working_directory must be a string");
  }
  if (input.block_until_ms !== undefined && typeof input.block_until_ms !== "number") {
    throw new Error("ExternalShell block_until_ms must be a number");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new Error("ExternalShell description must be a string");
  }
  if (input.machineId !== undefined && typeof input.machineId !== "string") {
    throw new Error("ExternalShell machineId must be a string");
  }
  return {
    command,
    ...(typeof input.working_directory === "string"
      ? { working_directory: input.working_directory }
      : {}),
    ...(typeof input.block_until_ms === "number" ? { block_until_ms: input.block_until_ms } : {}),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(typeof input.machineId === "string" ? { machineId: input.machineId } : {}),
    ...approvalTokens(input),
  };
};

export const parseHostReadRequest = (value: unknown): HostReadRequest => {
  const input = isRecord(value) ? value : {};
  const path = requiredString(input.path, "ExternalRead path");
  if (input.offset !== undefined && typeof input.offset !== "number") {
    throw new Error("ExternalRead offset must be a number");
  }
  if (input.limit !== undefined && typeof input.limit !== "number") {
    throw new Error("ExternalRead limit must be a number");
  }
  if (input.machineId !== undefined && typeof input.machineId !== "string") {
    throw new Error("ExternalRead machineId must be a string");
  }
  return {
    path,
    ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.machineId === "string" ? { machineId: input.machineId } : {}),
    ...approvalTokens(input),
  };
};

export const parseHostPermissionUpdateRequest = (value: unknown): HostPermissionUpdateRequest => {
  const input = isRecord(value) ? value : {};
  if (input.machineId !== undefined && typeof input.machineId !== "string") {
    throw new Error("machineId must be a string");
  }
  if (!["always", "ask", "never"].includes(String(input.localToolPermission))) {
    throw new Error("Invalid local computer permission");
  }
  return {
    ...(typeof input.machineId === "string" ? { machineId: input.machineId } : {}),
    localToolPermission: input.localToolPermission as HostLocalToolPermission,
  };
};

export const parseHostAutoReviewRequest = (value: unknown): HostAutoReviewRequest => {
  const input = isRecord(value) ? value : {};
  if (
    !["mcp", "computer", "automationWrite", "cloudAgent", "subagentLaunch"].includes(
      String(input.surface)
    )
  ) {
    throw new Error("Auto Review surface is invalid");
  }
  const summary = requiredString(input.summary, "Auto Review summary");
  const target = requiredString(input.target, "Auto Review target");
  if (input.command !== undefined && typeof input.command !== "string") {
    throw new Error("Auto Review command must be a string");
  }
  if (input.arguments !== undefined && !isRecord(input.arguments)) {
    throw new Error("Auto Review arguments must be an object");
  }
  return {
    surface: input.surface as HostAutoReviewRequest["surface"],
    summary,
    target,
    ...(typeof input.command === "string" ? { command: input.command } : {}),
    ...(isRecord(input.arguments) ? { arguments: input.arguments } : {}),
    ...approvalTokens(input),
  };
};

export const isHostApprovalRequest = (value: unknown): value is HostApprovalRequest =>
  isRecord(value) &&
  (value.gate === "local" || value.gate === "auto-review") &&
  (value.requestMethod === "openbot/localTool" || value.requestMethod === "openbot/autoReview") &&
  isRecord(value.details);

export const parseHostReadResponse = (value: unknown): HostReadResponse => {
  if (
    !isRecord(value) ||
    (value.kind !== "text" && value.kind !== "image") ||
    typeof value.path !== "string"
  ) {
    throw new Error("Physical-host read response is invalid");
  }
  if (
    value.kind === "image" &&
    (typeof value.data !== "string" || typeof value.mimeType !== "string")
  ) {
    throw new Error("Physical-host image response is invalid");
  }
  return value as unknown as HostReadResponse;
};

export const parseHostShellResponse = (value: unknown): HostShellResponse => {
  if (
    !isRecord(value) ||
    typeof value.shell_id !== "string" ||
    (value.status !== "completed" && value.status !== "running") ||
    (value.exit_code !== null && typeof value.exit_code !== "number") ||
    typeof value.output !== "string" ||
    typeof value.output_path !== "string" ||
    typeof value.elapsed_ms !== "number"
  ) {
    throw new Error("Physical-host shell response is invalid");
  }
  return value as unknown as HostShellResponse;
};

export const parseHostMachinesResponse = (value: unknown): HostMachinesResponse => {
  if (!isRecord(value) || !Array.isArray(value.machines)) {
    throw new Error("Physical-host machine response is invalid");
  }
  const machines = value.machines.map((machine) => {
    if (
      !isRecord(machine) ||
      typeof machine.machineId !== "string" ||
      typeof machine.label !== "string" ||
      !["always", "ask", "never"].includes(String(machine.localToolPermission))
    ) {
      throw new Error("Physical-host machine is invalid");
    }
    return machine as unknown as HostMachine;
  });
  return { machines };
};
