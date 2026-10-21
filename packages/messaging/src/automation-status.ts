import { describeTrigger } from "@openteam/contracts/reference-main-parsers";

/** A routine as the prompt sees it: its saved definition plus the run ledger. */
export interface RoutineStatusSource {
  id?: string;
  name: string;
  slug: string;
  enabled: boolean;
  trigger: unknown;
  scheduleText: string;
  nextRunAt: Date | null;
  runLedger: unknown;
}

interface LedgerRun {
  status: string;
  startedAt: number;
}

const ledgerRuns = (ledger: unknown): LedgerRun[] =>
  (Array.isArray(ledger) ? ledger : [])
    .flatMap((entry) =>
      entry && typeof entry === "object" && typeof entry.status === "string" && Number.isFinite(Number(entry.startedAt))
        ? [{ status: entry.status as string, startedAt: Number(entry.startedAt) }]
        : []
    )
    .sort((left, right) => right.startedAt - left.startedAt);

const formatTimestamp = (at: number | Date, timeZone: string): string => {
  const labeled = { timeZoneName: "short" } as const;
  try {
    return new Date(at).toLocaleString("en-US", { ...labeled, timeZone });
  } catch {
    return new Date(at).toLocaleString("en-US", labeled);
  }
};

const summarizeLastRun = (runs: readonly LedgerRun[], timeZone: string): string => {
  const last = runs[0];
  if (!last) return "never run";
  if (last.status === "running") return `running now (started ${formatTimestamp(last.startedAt, timeZone)})`;
  return `last run ${formatTimestamp(last.startedAt, timeZone)} (${last.status === "ok" ? "succeeded" : "failed"})`;
};

/** The static half of a routine's line, frozen in the system prompt with the rest of the Routines section. */
export const routineDefinitionLine = (routine: RoutineStatusSource): string => {
  const trigger = routine.trigger as { type?: unknown } | null;
  let described: string;
  try {
    described = describeTrigger(trigger as never);
  } catch {
    described = routine.scheduleText;
  }
  const raw = trigger?.type === "cron" ? ` (${routine.scheduleText})` : "";
  return `- ${routine.name} [${routine.enabled ? "enabled" : "paused"}]: ${described}${raw}; folder ${routine.slug}`;
};

const AUTOMATION_STATUS_HEADER =
  "Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.";

/** Per-turn runtime status, as the reference's <automation_status> reminder. The firing routine's own run is left out. */
export const renderAutomationStatusReminder = (
  routines: readonly RoutineStatusSource[],
  timeZone: string,
  firingRoutineId?: string | null
): string | null => {
  if (routines.length === 0) return null;
  const lines = routines.map((routine) => {
    const runs = ledgerRuns(routine.runLedger).filter(
      (run) => routine.id === undefined || routine.id !== firingRoutineId || run.status !== "running"
    );
    const next = routine.enabled && routine.nextRunAt ? `next run ${formatTimestamp(routine.nextRunAt, timeZone)}; ` : "";
    return `- ${routine.name} (folder ${routine.slug}): ${next}${summarizeLastRun(runs, timeZone)}`;
  });
  return ["<system_reminder>", "<automation_status>", AUTOMATION_STATUS_HEADER, ...lines, "</automation_status>", "</system_reminder>"].join("\n");
};

export const AUTOMATION_STATUS_CLEARED = [
  "<system_reminder>",
  "<automation_status>",
  AUTOMATION_STATUS_HEADER,
  "No current routines.",
  "</automation_status>",
  "</system_reminder>",
].join("\n");
