import type { RoutineExecutionView, RoutineView } from "@openbot/contracts";
import {
  formatRoutineExecutionCalendarTime,
  routineOrdinalLabel,
} from "@openbot/product-core/routines";
import { isTransientRoutineExecutionStatus } from "@openbot/product-core/statuses";

export type { RoutineExecutionView, RoutineView } from "@openbot/contracts";

/**
 * The routine summary refreshes while it is visible. Preserve the current
 * array when none of the fields that can change the visible rows changed, so
 * a poll does not rebuild a large list every three seconds.
 */
export const routineSummaryProjectionEqual = (
  current: RoutineView[] | null,
  next: RoutineView[]
): boolean =>
  current !== null &&
  current.length === next.length &&
  current.every((routine, index) => {
    const candidate = next[index];
    return (
      candidate !== undefined &&
      routine.id === candidate.id &&
      routine.revision === candidate.revision &&
      routine.name === candidate.name &&
      routine.enabled === candidate.enabled &&
      routine.schedule === candidate.schedule &&
      routine.latestExecution?.id === candidate.latestExecution?.id &&
      routine.latestExecution?.status === candidate.latestExecution?.status
    );
  });

export type RoutineSchedulePreset =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "interval"
  | "advanced"
  | "custom";

export const formatRoutineExecutionTime = (
  execution: RoutineExecutionView,
  now = new Date(),
  locale?: string
): string => {
  const when = new Date(execution.completedAt ?? execution.startedAt ?? execution.createdAt);
  const elapsed = now.getTime() - when.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "Just now";
  if (elapsed >= 60_000 && elapsed < 3_600_000) {
    return `${Math.floor(elapsed / 60_000)} min ago`;
  }

  return formatRoutineExecutionCalendarTime(execution, now, locale);
};

export interface RoutineScheduleDraft {
  preset: RoutineSchedulePreset;
  minute: number;
  time: string;
  weekDay: number;
  monthDay: number;
  intervalAmount: number;
  intervalUnit: "m" | "h" | "d";
  advancedMonths: number[];
  advancedDayMode: "every-day" | "weekdays" | "month-days";
  advancedWeekDays: number[];
  advancedMonthDays: number[];
  advancedTimeMode: "at-times" | "every";
  advancedTimes: string[];
  advancedEveryAmount: number;
  advancedEveryUnit: "m" | "h" | "d";
  advancedFromTime: string;
  advancedToTime: string;
  customSchedule: string;
}

export const DEFAULT_ROUTINE_SCHEDULE: RoutineScheduleDraft = {
  preset: "weekdays",
  minute: 0,
  time: "08:00",
  weekDay: 1,
  monthDay: 1,
  intervalAmount: 30,
  intervalUnit: "m",
  advancedMonths: [],
  advancedDayMode: "every-day",
  advancedWeekDays: [1],
  advancedMonthDays: [1],
  advancedTimeMode: "every",
  advancedTimes: ["08:00"],
  advancedEveryAmount: 30,
  advancedEveryUnit: "m",
  advancedFromTime: "00:00",
  advancedToTime: "23:00",
  customSchedule: "@every 30m",
};

const clock = (hour: string, minute: string) =>
  `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;

export const parseRoutineSchedule = (schedule: string): RoutineScheduleDraft => {
  const raw = schedule.trim().replace(/^(?:CRON_TZ|TZ)=[^\s]+\s+/, "");
  const interval = raw.match(/^@every\s+(\d+)(m|h|d)$/i);
  if (interval?.[1] && interval[2]) {
    return {
      ...DEFAULT_ROUTINE_SCHEDULE,
      preset: "interval",
      intervalAmount: Number(interval[1]),
      intervalUnit: interval[2].toLowerCase() as RoutineScheduleDraft["intervalUnit"],
      customSchedule: raw,
    };
  }
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) {
    return { ...DEFAULT_ROUTINE_SCHEDULE, preset: "custom", customSchedule: raw };
  }
  const [minute, hour, day, month, weekday] = fields;
  if (
    /^\d+$/.test(minute ?? "") &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    return {
      ...DEFAULT_ROUTINE_SCHEDULE,
      preset: "hourly",
      minute: Number(minute),
      customSchedule: raw,
    };
  }
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && month === "*") {
    const base = {
      ...DEFAULT_ROUTINE_SCHEDULE,
      time: clock(hour ?? "9", minute ?? "0"),
      customSchedule: raw,
    };
    if (day === "*" && weekday === "1-5") return { ...base, preset: "weekdays" };
    if (day === "*" && weekday !== "*" && /^\d$/.test(weekday ?? "")) {
      return { ...base, preset: "weekly", weekDay: Number(weekday) };
    }
    if (day !== "*" && /^\d+$/.test(day ?? "")) {
      return { ...base, preset: "monthly", monthDay: Number(day) };
    }
    if (day === "*" && weekday === "*") return { ...base, preset: "daily" };
  }
  const steppedMinutes = raw.match(/^\*\/(\d+) (\*|\d+-\d+) (\*|[\d,]+) (\*|[\d,]+) (\*|[\d,]+)$/);
  if (steppedMinutes?.[1]) {
    const hourRange = steppedMinutes[2]?.match(/^(\d+)-(\d+)$/);
    const parseList = (value: string | undefined) =>
      value && value !== "*" ? value.split(",").map(Number).filter(Number.isFinite) : [];
    const dayValues = parseList(steppedMinutes[3]);
    const weekValues = parseList(steppedMinutes[5]);
    return {
      ...DEFAULT_ROUTINE_SCHEDULE,
      preset: "advanced",
      advancedMonths: parseList(steppedMinutes[4]),
      advancedDayMode:
        weekValues.length > 0 ? "weekdays" : dayValues.length > 0 ? "month-days" : "every-day",
      advancedWeekDays: weekValues.length > 0 ? weekValues : [1],
      advancedMonthDays: dayValues.length > 0 ? dayValues : [1],
      advancedEveryAmount: Number(steppedMinutes[1]),
      advancedFromTime: `${String(Number(hourRange?.[1] ?? 0)).padStart(2, "0")}:00`,
      advancedToTime: `${String(Number(hourRange?.[2] ?? 23)).padStart(2, "0")}:00`,
      customSchedule: raw,
    };
  }
  return { ...DEFAULT_ROUTINE_SCHEDULE, preset: "custom", customSchedule: raw };
};

const timeFields = (time: string): [number, number] => {
  const [hour, minute] = time.split(":").map(Number);
  return [
    typeof hour === "number" && Number.isFinite(hour) ? hour : 9,
    typeof minute === "number" && Number.isFinite(minute) ? minute : 0,
  ];
};

export const routineScheduleValue = (draft: RoutineScheduleDraft): string => {
  const [hour, minute] = timeFields(draft.time);
  switch (draft.preset) {
    case "hourly":
      return `${Math.max(0, Math.min(59, draft.minute))} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${Math.max(0, Math.min(6, draft.weekDay))}`;
    case "monthly":
      return `${minute} ${hour} ${Math.max(1, Math.min(31, draft.monthDay))} * *`;
    case "interval":
      return `@every ${Math.max(1, draft.intervalAmount)}${draft.intervalUnit}`;
    case "advanced": {
      const monthField = listField(draft.advancedMonths);
      const dayField =
        draft.advancedDayMode === "month-days" ? listField(draft.advancedMonthDays) : "*";
      const weekField =
        draft.advancedDayMode === "weekdays" ? listField(draft.advancedWeekDays) : "*";
      if (draft.advancedTimeMode === "at-times") {
        const times = draft.advancedTimes.length > 0 ? draft.advancedTimes : ["08:00"];
        const [itemHour, itemMinute] = timeFields(times[0] ?? "08:00");
        return `${itemMinute} ${itemHour} ${dayField} ${monthField} ${weekField}`;
      }
      const amount = Math.max(1, draft.advancedEveryAmount);
      const [fromHour] = timeFields(draft.advancedFromTime);
      const [toHour] = timeFields(draft.advancedToTime);
      const hourRange = fromHour === 0 && toHour === 23 ? "*" : `${fromHour}-${toHour}`;
      if (draft.advancedEveryUnit === "h") {
        return `0 ${hourRange === "*" ? `*/${Math.min(23, amount)}` : `${hourRange}/${Math.min(23, amount)}`} ${dayField} ${monthField} ${weekField}`;
      }
      if (draft.advancedEveryUnit === "d") {
        return `0 ${fromHour} */${Math.min(31, amount)} ${monthField} ${weekField}`;
      }
      return `*/${Math.min(59, amount)} ${hourRange} ${dayField} ${monthField} ${weekField}`;
    }
    case "custom":
      return draft.customSchedule.trim();
  }
};

export const routineScheduleValues = (draft: RoutineScheduleDraft): string[] => {
  if (draft.preset !== "advanced" || draft.advancedTimeMode !== "at-times") {
    return [routineScheduleValue(draft)];
  }
  const monthField = listField(draft.advancedMonths);
  const dayField =
    draft.advancedDayMode === "month-days" ? listField(draft.advancedMonthDays) : "*";
  const weekField = draft.advancedDayMode === "weekdays" ? listField(draft.advancedWeekDays) : "*";
  const times = draft.advancedTimes.length > 0 ? draft.advancedTimes : ["08:00"];
  return [...new Set(times)].map((time) => {
    const [hour, minute] = timeFields(time);
    return `${minute} ${hour} ${dayField} ${monthField} ${weekField}`;
  });
};

const listField = (values: readonly number[]): string =>
  values.length > 0 ? [...new Set(values)].sort((left, right) => left - right).join(",") : "*";

export const routineTriggerValue = (
  drafts: readonly RoutineScheduleDraft[],
  timeZone?: string
): Record<string, unknown> => {
  const listeners = drafts.flatMap((draft) =>
    routineScheduleValues(draft).map((schedule) => ({
      type: "cron",
      schedule:
        timeZone && !schedule.startsWith("@every ") && !/^(?:CRON_TZ|TZ)=/.test(schedule)
          ? `CRON_TZ=${timeZone} ${schedule}`
          : schedule,
    }))
  );
  return listeners.length === 1
    ? (listeners[0] ?? { type: "cron", schedule: "" })
    : { type: "group", listeners };
};

export const routineScheduleDrafts = (routine: RoutineView): RoutineScheduleDraft[] => {
  const presented = routinePresentationDrafts(routine.triggerPresentation);
  if (presented) return presented;
  const schedules = routine.schedules.length > 0 ? routine.schedules : [routine.schedule];
  return schedules.map(parseRoutineSchedule);
};

const schedulePresets = new Set<RoutineSchedulePreset>([
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "interval",
  "advanced",
  "custom",
]);

const finiteNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const boundedNumbers = (value: unknown, minimum: number, maximum: number): value is number[] =>
  finiteNumbers(value) && value.every((item) => item >= minimum && item <= maximum);

const validClock = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    hour! >= 0 &&
    hour! <= 23 &&
    minute! >= 0 &&
    minute! <= 59
  );
};

const presentedSchedule = (value: unknown): RoutineScheduleDraft | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<RoutineScheduleDraft>;
  if (!item.preset || !schedulePresets.has(item.preset)) return null;
  if (
    typeof item.minute !== "number" ||
    !validClock(item.time) ||
    typeof item.weekDay !== "number" ||
    item.weekDay < 0 ||
    item.weekDay > 6 ||
    typeof item.monthDay !== "number" ||
    item.monthDay < 1 ||
    item.monthDay > 31 ||
    typeof item.intervalAmount !== "number" ||
    item.intervalAmount < 1 ||
    !["m", "h", "d"].includes(item.intervalUnit ?? "") ||
    !boundedNumbers(item.advancedMonths, 1, 12) ||
    !["every-day", "weekdays", "month-days"].includes(item.advancedDayMode ?? "") ||
    !boundedNumbers(item.advancedWeekDays, 0, 6) ||
    !boundedNumbers(item.advancedMonthDays, 1, 31) ||
    !["at-times", "every"].includes(item.advancedTimeMode ?? "") ||
    !stringList(item.advancedTimes) ||
    !item.advancedTimes.every(validClock) ||
    typeof item.advancedEveryAmount !== "number" ||
    item.advancedEveryAmount < 1 ||
    !["m", "h", "d"].includes(item.advancedEveryUnit ?? "") ||
    !validClock(item.advancedFromTime) ||
    !validClock(item.advancedToTime) ||
    typeof item.customSchedule !== "string" ||
    item.customSchedule.length > 500
  ) {
    return null;
  }
  return item as RoutineScheduleDraft;
};

export const routinePresentationDrafts = (presentation: unknown): RoutineScheduleDraft[] | null => {
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null;
  const value = presentation as { version?: unknown; kind?: unknown; schedules?: unknown };
  if (
    value.version !== 2 ||
    value.kind !== "grok-time-routines" ||
    !Array.isArray(value.schedules)
  ) {
    return null;
  }
  const schedules = value.schedules.map(presentedSchedule);
  return schedules.length > 0 && schedules.every(Boolean)
    ? (schedules as RoutineScheduleDraft[])
    : null;
};

export const routinePresentationValue = (
  schedules: readonly RoutineScheduleDraft[]
): Record<string, unknown> => ({
  version: 2,
  kind: "grok-time-routines",
  schedules,
});

const formatTime = (time: string) => {
  const [hour, minute] = timeFields(time);
  return new Date(2026, 0, 1, hour, minute).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const advancedDayDescription = (draft: RoutineScheduleDraft): string => {
  if (draft.advancedDayMode === "weekdays") {
    return ` on ${draft.advancedWeekDays.map((day) => WEEKDAYS[day] ?? "Monday").join(", ")}`;
  }
  if (draft.advancedDayMode === "month-days") {
    return ` on the ${draft.advancedMonthDays.map(routineOrdinalLabel).join(", ")}`;
  }
  return "";
};

const describeAdvancedTimes = (draft: RoutineScheduleDraft): string => {
  const times = draft.advancedTimes.length > 0 ? draft.advancedTimes : ["08:00"];
  const minutes = times.map((time) => {
    const [hour, minute] = timeFields(time);
    return hour * 60 + minute;
  });
  const spacing = (minutes[1] ?? 0) - (minutes[0] ?? 0);
  const evenlySpaced =
    times.length > 1 &&
    spacing > 0 &&
    minutes.slice(2).every((value, index) => value - (minutes[index + 1] ?? value) === spacing);
  const day = advancedDayDescription(draft);
  if (evenlySpaced) {
    const cadence =
      spacing === 60
        ? "Every hour"
        : spacing % 60 === 0
          ? `Every ${spacing / 60} hours`
          : `Every ${spacing} minutes`;
    return `${cadence}${day}, ${formatTime(times[0] ?? "08:00")} – ${formatTime(times.at(-1) ?? "08:00")}`;
  }
  return `At ${times.map(formatTime).join(", ")}${day}`;
};

export const describeRoutineSchedule = (draft: RoutineScheduleDraft): string => {
  switch (draft.preset) {
    case "hourly":
      return draft.minute === 0
        ? "Every hour"
        : `Every hour at :${String(draft.minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${formatTime(draft.time)}`;
    case "weekdays":
      return `On weekdays at ${formatTime(draft.time)}`;
    case "weekly":
      return `Every ${WEEKDAYS[draft.weekDay] ?? "Monday"} at ${formatTime(draft.time)}`;
    case "monthly":
      return `Monthly on the ${routineOrdinalLabel(draft.monthDay)} at ${formatTime(draft.time)}`;
    case "interval":
      return `Every ${draft.intervalAmount} ${unitLabel(draft.intervalUnit, draft.intervalAmount)}`;
    case "advanced": {
      if (draft.advancedTimeMode === "at-times" && draft.advancedTimes.length === 1) {
        const time = formatTime(draft.advancedTimes[0] ?? "08:00");
        if (draft.advancedDayMode === "weekdays" && draft.advancedWeekDays.length === 1) {
          return `Every ${WEEKDAYS[draft.advancedWeekDays[0] ?? 1] ?? "Monday"} at ${time}`;
        }
        if (draft.advancedDayMode === "month-days" && draft.advancedMonthDays.length === 1) {
          return `Monthly on the ${routineOrdinalLabel(draft.advancedMonthDays[0] ?? 1)} at ${time}`;
        }
        if (draft.advancedDayMode === "every-day") return `Every day at ${time}`;
      }
      if (draft.advancedTimeMode === "at-times") return describeAdvancedTimes(draft);
      const cadence = `Every ${draft.advancedEveryAmount} ${unitLabel(
        draft.advancedEveryUnit,
        draft.advancedEveryAmount
      )}`;
      if (draft.advancedDayMode === "weekdays") {
        const days = draft.advancedWeekDays.map((day) => WEEKDAYS[day] ?? "Monday");
        return `${cadence} on ${days.join(", ")}`;
      }
      if (draft.advancedDayMode === "month-days") {
        return `${cadence} on the ${draft.advancedMonthDays.map(routineOrdinalLabel).join(", ")}`;
      }
      return cadence;
    }
    case "custom": {
      const interval = draft.customSchedule.trim().match(/^@every\s+(\d+)(m|h|d)$/i);
      if (interval?.[1] && interval[2]) {
        const amount = Number(interval[1]);
        return `Every ${amount} ${unitLabel(
          interval[2].toLowerCase() as RoutineScheduleDraft["intervalUnit"],
          amount
        )}`;
      }
      return `Cron ${draft.customSchedule.trim()}`;
    }
  }
};

export const describeRoutineSchedules = (drafts: readonly RoutineScheduleDraft[]): string =>
  drafts
    .map(describeRoutineSchedule)
    .map((description, index) => {
      if (index === 0) return description;
      const continuation = description.replace(/^On /, "");
      return `${continuation.charAt(0).toLowerCase()}${continuation.slice(1)}`;
    })
    .join(" or ");

const unitLabel = (unit: RoutineScheduleDraft["intervalUnit"], amount: number) => {
  const label = unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
  return amount === 1 ? label : `${label}s`;
};

export const routineIsRunning = (routine: RoutineView): boolean =>
  Boolean(
    routine.latestExecution && isTransientRoutineExecutionStatus(routine.latestExecution.status)
  );

export const routineDraftValid = (input: {
  name: string;
  prompt: string;
  schedule: RoutineScheduleDraft;
}): boolean => {
  if (!input.name.trim() || !input.prompt.trim()) return false;
  const schedule = routineScheduleValue(input.schedule);
  if (!schedule) return false;
  if (/^@every\s+\d+(?:ms|s|m|h|d)(?:\/\d+(?:ms|s|m|h|d))?$/i.test(schedule)) return true;
  if (/^@(hourly|daily|midnight|weekly|monthly|yearly|annually)$/i.test(schedule)) return true;
  return (
    schedule
      .replace(/^(?:CRON_TZ|TZ)=[^\s]+\s+/, "")
      .trim()
      .split(/\s+/).length === 5
  );
};
