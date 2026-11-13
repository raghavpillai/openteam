import type { RoutineExecutionView, RoutineView, UpdateRoutineInput } from "@openteam/contracts";

type RoutineScheduleEditMode = "editable" | "event" | "composite";

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

interface RoutineExecutionStatusPresentation {
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
  if (style === "activity" && ["queued", "running"].includes(status)) {
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
    case "queued":
      return { label: "Queued", tone: "muted" };
    case "running":
      return { label: "Running", tone: "muted" };
  }
};
