import type { ApprovalView, RunItemView, RunView, SubagentActivityView } from "@openbot/contracts";

export const ACTIVE_ASYNC_TASK_STATUSES = new Set<SubagentActivityView["status"]>([
  "provisioning",
  "queued",
  "running",
]);

const taskTimestamp = (task: SubagentActivityView): number =>
  new Date(task.updatedAt || task.createdAt).getTime();

export const activeAsyncTasksForBot = (
  attempts: readonly SubagentActivityView[],
  parentBotId: string
): SubagentActivityView[] => {
  const bySubagentId = new Map<string, SubagentActivityView>();
  for (const attempt of attempts) {
    if (attempt.parentBotId !== parentBotId || !ACTIVE_ASYNC_TASK_STATUSES.has(attempt.status)) {
      continue;
    }
    const current = bySubagentId.get(attempt.subagentId);
    if (!current || taskTimestamp(attempt) >= taskTimestamp(current)) {
      bySubagentId.set(attempt.subagentId, attempt);
    }
  }
  return [...bySubagentId.values()].sort(
    (left, right) =>
      new Date(left.startedAt ?? left.createdAt).getTime() -
        new Date(right.startedAt ?? right.createdAt).getTime() || left.id.localeCompare(right.id)
  );
};

export const activeAsyncTaskChannelIds = (
  attempts: readonly SubagentActivityView[]
): ReadonlySet<string> =>
  new Set(
    attempts
      .filter((attempt) => ACTIVE_ASYNC_TASK_STATUSES.has(attempt.status))
      .map((attempt) => attempt.parentChannelId)
  );

export const asyncTaskElapsed = (task: SubagentActivityView, nowMs: number): string => {
  const startedAtMs = new Date(task.startedAt ?? task.createdAt).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h`;
  return `${Math.floor(elapsedSeconds / 86_400)}d`;
};

export const conversationApprovals = (
  runs: readonly RunView[],
  subagents: readonly SubagentActivityView[],
  approvalsByRun: ReadonlyMap<string, readonly ApprovalView[]>
): ApprovalView[] => {
  const runIds = [
    ...runs.map((run) => run.id),
    ...subagents.flatMap((subagent) => (subagent.currentRunId ? [subagent.currentRunId] : [])),
  ];
  const seen = new Set<string>();
  return runIds
    .flatMap((runId) =>
      (approvalsByRun.get(runId) ?? []).filter((approval) => {
        if (seen.has(approval.id)) return false;
        seen.add(approval.id);
        return true;
      })
    )
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id)
    );
};

const SUMMARY_CHARACTER_LIMIT = 1_500;
const SUMMARY_DEPTH_LIMIT = 5;
const SUMMARY_ENTRY_LIMIT = 32;
const SUMMARY_NODE_LIMIT = 160;

interface PreviewBudget {
  nodes: number;
}

const boundedPreviewValue = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: PreviewBudget
): unknown => {
  if (typeof value === "string") {
    return value.length > SUMMARY_CHARACTER_LIMIT
      ? `${value.slice(0, SUMMARY_CHARACTER_LIMIT)}…`
      : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (depth >= SUMMARY_DEPTH_LIMIT || budget.nodes >= SUMMARY_NODE_LIMIT) return "[…]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  budget.nodes += 1;
  if (Array.isArray(value)) {
    const preview = value
      .slice(0, SUMMARY_ENTRY_LIMIT)
      .map((item) => boundedPreviewValue(item, depth + 1, seen, budget));
    if (value.length > SUMMARY_ENTRY_LIMIT) {
      preview.push(`… ${value.length - SUMMARY_ENTRY_LIMIT} more items`);
    }
    seen.delete(value);
    return preview;
  }
  const entries = Object.entries(value);
  const preview: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, SUMMARY_ENTRY_LIMIT)) {
    if (budget.nodes >= SUMMARY_NODE_LIMIT) {
      preview["…"] = "More content omitted";
      break;
    }
    preview[key] = boundedPreviewValue(item, depth + 1, seen, budget);
  }
  if (entries.length > SUMMARY_ENTRY_LIMIT) {
    preview["…"] = `${entries.length - SUMMARY_ENTRY_LIMIT} more fields`;
  }
  seen.delete(value);
  return preview;
};

/** Serialize an untrusted activity payload without walking an unbounded or cyclic graph. */
export const activityContentSummary = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > SUMMARY_CHARACTER_LIMIT
      ? `${trimmed.slice(0, SUMMARY_CHARACTER_LIMIT)}…`
      : trimmed;
  }
  if (!value || typeof value !== "object") return null;
  try {
    const serialized = JSON.stringify(
      boundedPreviewValue(value, 0, new WeakSet(), { nodes: 0 }),
      null,
      2
    );
    if (!serialized) return null;
    return serialized.length > SUMMARY_CHARACTER_LIMIT
      ? `${serialized.slice(0, SUMMARY_CHARACTER_LIMIT)}…`
      : serialized;
  } catch {
    return null;
  }
};

export type ActivityRow =
  | { key: string; type: "run"; run: RunView; itemCount: number }
  | { key: string; type: "item"; item: RunItemView; last: boolean }
  | { key: "tasks"; type: "tasks" }
  | { key: string; type: "subagent"; subagent: SubagentActivityView };

export const activityRows = (
  runs: readonly RunView[],
  items: readonly RunItemView[],
  subagents: readonly SubagentActivityView[]
): ActivityRow[] => {
  const itemsByRun = new Map<string, RunItemView[]>();
  for (const item of items) {
    const current = itemsByRun.get(item.runId);
    if (current) current.push(item);
    else itemsByRun.set(item.runId, [item]);
  }
  const rows: ActivityRow[] = [];
  for (const run of runs) {
    const runItems = itemsByRun.get(run.id) ?? [];
    rows.push({ key: `run:${run.id}`, type: "run", run, itemCount: runItems.length });
    runItems.forEach((item, index) => {
      rows.push({
        key: `item:${item.id}`,
        type: "item",
        item,
        last: index === runItems.length - 1,
      });
    });
  }
  if (subagents.length > 0) {
    rows.push({ key: "tasks", type: "tasks" });
    for (const subagent of subagents) {
      rows.push({ key: `subagent:${subagent.id}`, type: "subagent", subagent });
    }
  }
  return rows;
};

export interface ApprovalPresentation {
  kind: "local-tool" | "auto-review" | "generic";
  pending: boolean;
  title: string;
  description: string;
  statusLabel: string;
  details: Record<string, unknown>;
  action: string | null;
  heading: string;
  effect: string | null;
  resolution: string | null;
  supportsAlwaysAllow: boolean;
  supportsNever: boolean;
  visibleArguments: unknown;
  argumentRecord: Record<string, unknown>;
  machineLabel: string;
  localCapability: string;
  rawDetails: string | null;
  detailsLabel: "command" | "details";
  taskReview: boolean;
  reviewSummary: string;
  reason: string | null;
  proposedRule: string | null;
}

export const approvalPresentation = (
  approval: Pick<ApprovalView, "details" | "status">
): ApprovalPresentation => {
  const details =
    approval.details && typeof approval.details === "object" && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  const action = typeof details.action === "string" ? details.action : null;
  const toolName = typeof details.toolName === "string" ? details.toolName : null;
  const heading = action
    ? action.replace(/([a-z])([A-Z])/g, "$1 $2")
    : toolName
      ? `Allow ${toolName}`
      : "Approval required";
  const effect = typeof details.effect === "string" ? details.effect : null;
  const resolution = typeof details.resolution === "string" ? details.resolution : null;
  const kind =
    details.type === "localTool"
      ? "local-tool"
      : details.type === "autoReview"
        ? "auto-review"
        : "generic";
  const visibleArguments = details.arguments;
  const argumentRecord =
    visibleArguments && typeof visibleArguments === "object" && !Array.isArray(visibleArguments)
      ? (visibleArguments as Record<string, unknown>)
      : {};
  const command = typeof argumentRecord.command === "string" ? argumentRecord.command : null;
  const path = typeof argumentRecord.path === "string" ? argumentRecord.path : null;
  const task = typeof argumentRecord.task === "string" ? argumentRecord.task : null;
  const prompt = typeof argumentRecord.prompt === "string" ? argumentRecord.prompt : null;
  const rawDetails = command ?? path ?? task ?? prompt ?? activityContentSummary(visibleArguments);
  const machineLabel =
    typeof details.machineLabel === "string" && details.machineLabel.trim()
      ? details.machineLabel.trim()
      : "this computer";
  const localCapability = action === "readFile" ? "read files on" : "run commands on";
  const pending = approval.status === "pending";
  const taskReview = action === "runTask";
  const suppliedSummary =
    typeof details.summary === "string" && details.summary.trim()
      ? details.summary.trim()
      : action === "readFile" && path
        ? `Read ${path}`
        : action === "runCommand"
          ? "Run a command"
          : heading;
  const reason = typeof details.reason === "string" ? details.reason : effect;
  const proposedRule =
    typeof details.proposedRule === "string" && details.proposedRule.trim()
      ? details.proposedRule.trim()
      : null;
  const autoReviewTitle =
    action === "runCommand"
      ? "The Bot wants to run a command"
      : action === "readFile"
        ? "The Bot wants to read a file"
        : "The Bot wants to run a task";
  const genericStatus =
    approval.status === "accepted"
      ? "Approved"
      : approval.status === "declined"
        ? "Declined"
        : approval.status === "cancelled"
          ? "Cancelled"
          : approval.status === "expired"
            ? "Expired"
            : "Approval required";
  const localStatus =
    resolution === "accept"
      ? `OpenBot can ${localCapability} your computer this time.`
      : resolution === "always_allow"
        ? `OpenBot can always ${localCapability} your computer.`
        : approval.status === "declined"
          ? `OpenBot was not allowed to ${localCapability} your computer.`
          : approval.status === "cancelled"
            ? "Local computer approval was cancelled."
            : approval.status === "expired"
              ? "Local computer approval expired."
              : "OpenBot was not allowed to use your computer.";
  const autoReviewStatus = pending
    ? "Approval needed"
    : approval.status === "accepted"
      ? resolution === "always_allow"
        ? "Always allowed"
        : "Allowed once"
      : approval.status === "declined"
        ? "Denied"
        : approval.status === "cancelled"
          ? "Cancelled"
          : approval.status === "expired"
            ? "Expired"
            : "Reviewed";
  const title =
    typeof details.title === "string"
      ? details.title
      : kind === "auto-review"
        ? autoReviewTitle
        : kind === "local-tool"
          ? (effect ?? heading)
          : heading;
  const description =
    typeof details.description === "string"
      ? details.description
      : kind === "local-tool"
        ? `${machineLabel}. This applies to OpenBot and every Bot and can be changed in Settings.`
        : kind === "auto-review"
          ? (reason ?? suppliedSummary)
          : (effect ?? "Review this action before OpenBot continues.");

  return {
    kind,
    pending,
    title,
    description,
    statusLabel:
      kind === "local-tool"
        ? localStatus
        : kind === "auto-review"
          ? autoReviewStatus
          : genericStatus,
    details,
    action,
    heading,
    effect,
    resolution,
    supportsAlwaysAllow: details.supportsAlwaysAllow === true,
    supportsNever: details.supportsNever === true,
    visibleArguments,
    argumentRecord,
    machineLabel,
    localCapability,
    rawDetails,
    detailsLabel: command ? "command" : "details",
    taskReview,
    reviewSummary: suppliedSummary,
    reason,
    proposedRule,
  };
};
