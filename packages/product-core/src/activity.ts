import type { RunItemView, RunView, SubagentActivityView } from "@openteam/contracts";

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
