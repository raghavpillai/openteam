import type { RoutineExecutionView, RoutineView, UpdateRoutineInput } from "@openteam/contracts";

export type RoutineScheduleEditMode = "editable" | "event" | "composite";

const triggerType = (trigger: unknown): unknown =>
  trigger && typeof trigger === "object" && !Array.isArray(trigger)
    ? (trigger as Record<string, unknown>).type
    : null;

/** A simple client must never flatten an event or grouped schedule while editing other fields. */
export const routineScheduleEditMode = (routine: RoutineView | null): RoutineScheduleEditMode => {
  if (!routine || routine.scheduleKind === "event") return routine ? "event" : "editable";
  return routine.schedules.length > 1 || triggerType(routine.trigger) === "group"
    ? "composite"
    : "editable";
};

export const routineSchedulePatch = (
  routine: RoutineView,
  schedule: string
): Pick<UpdateRoutineInput, "schedule"> | Record<never, never> => {
  const normalized = schedule.trim();
  return routineScheduleEditMode(routine) === "editable" && normalized !== routine.schedule
    ? { schedule: normalized }
    : {};
};

const ROUTINE_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const routineTimeLabel = (hour: number, minute: number, locale?: string): string =>
  new Date(2026, 0, 1, hour, minute).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });

const routineIntervalUnitLabel = (unit: string, amount: number): string => {
  const label =
    unit === "ms"
      ? "millisecond"
      : unit === "s"
        ? "second"
        : unit === "m"
          ? "minute"
          : unit === "h"
            ? "hour"
            : "day";
  return amount === 1 ? label : `${label}s`;
};

/** Formats an integer for human-facing schedule and list labels. */
export const routineOrdinalLabel = (value: number): string => {
  const mod100 = value % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : value % 10 === 1
        ? "st"
        : value % 10 === 2
          ? "nd"
          : value % 10 === 3
            ? "rd"
            : "th";
  return `${value}${suffix}`;
};

/** Describes the server's cron/interval representation without exposing cron for common cases. */
export const describeRoutineCronSchedule = (schedule: string, locale?: string): string => {
  const normalized = schedule.replace(/^(?:CRON_TZ|TZ)=[^\s]+\s+/, "").trim();
  if (!normalized) return "Event-triggered";

  const interval = normalized.match(/^@every\s+(\d+)(ms|s|m|h|d)$/i);
  if (interval?.[1] && interval[2]) {
    const amount = Number(interval[1]);
    return `Every ${amount} ${routineIntervalUnitLabel(interval[2].toLowerCase(), amount)}`;
  }

  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return normalized;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = Number(minuteField);
  const hour = Number(hourField);

  if (
    /^\d+$/.test(minuteField ?? "") &&
    hourField === "*" &&
    dayField === "*" &&
    monthField === "*" &&
    weekdayField === "*"
  ) {
    return minute === 0 ? "Every hour" : `Every hour at :${String(minute).padStart(2, "0")}`;
  }

  if (/^\d+$/.test(minuteField ?? "") && /^\d+$/.test(hourField ?? "") && monthField === "*") {
    const time = routineTimeLabel(hour, minute, locale);
    if (dayField === "*" && weekdayField === "1-5") return `Weekdays at ${time}`;
    if (dayField === "*" && weekdayField === "*") return `Daily at ${time}`;
    if (dayField === "*" && /^\d$/.test(weekdayField ?? "")) {
      return `${ROUTINE_WEEKDAYS[Number(weekdayField)] ?? "Monday"}s at ${time}`;
    }
    if (/^\d+$/.test(dayField ?? "") && weekdayField === "*") {
      return `Monthly on the ${routineOrdinalLabel(Number(dayField))} at ${time}`;
    }
  }

  return `Cron ${normalized}`;
};

export const routineScheduleSummary = (routine: RoutineView, locale?: string): string => {
  const schedule = describeRoutineCronSchedule(routine.schedule, locale);
  return routine.enabled ? schedule : `${schedule} · Paused`;
};

export const formatRoutineExecutionCalendarTime = (
  execution: RoutineExecutionView,
  now = new Date(),
  locale?: string
): string => {
  const when = new Date(execution.completedAt ?? execution.startedAt ?? execution.createdAt);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startThen = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const calendarDays = Math.round((startToday.getTime() - startThen.getTime()) / 86_400_000);
  const time = when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (calendarDays === 0) return `Today at ${time}`;
  if (calendarDays === 1) return `Yesterday at ${time}`;
  if (calendarDays > 1 && calendarDays < 7) {
    return `Last ${when.toLocaleDateString(locale, { weekday: "long" })} at ${time}`;
  }
  return when.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export interface RoutineExecutionStatusPresentation {
  label: string;
  tone: "success" | "danger" | "muted";
}

export const routineExecutionStatusPresentation = (
  status: RoutineExecutionView["status"],
  style: "detail" | "activity" | "raw" = "detail"
): RoutineExecutionStatusPresentation => {
  // Labels are deliberately presentation-specific: this extraction must not
  // rename the desktop activity indicator or the native editor's existing rows.
  if (style === "raw")
    return { ...routineExecutionStatusPresentation(status), label: status.replace("_", " ") };
  if (style === "activity" && ["queued", "running", "waiting_approval"].includes(status)) {
    return { label: "Running", tone: "muted" };
  }
  switch (status) {
    case "completed":
      return { label: "Succeeded", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
    case "waiting_approval":
      return { label: "Needs approval", tone: "muted" };
    case "queued":
      return { label: "Queued", tone: "muted" };
    case "running":
      return { label: "Running", tone: "muted" };
  }
};
