import {
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Clock3,
  Globe2,
  LoaderCircle,
  Pause,
  Radio,
  X,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { routineOrdinalLabel } from "@openbot/product-core/routines";
import { isTransientRoutineExecutionStatus } from "@openbot/product-core/statuses";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ClientError } from "../../client/http";
import { api } from "../../client/openbot-api";
import { cn } from "../../lib/cn";
import {
  defaultRoutineTriggerDraft,
  describeRoutineTrigger,
  type RoutineTriggerDraft,
  type RoutineTriggerKind,
  routineDraftTriggerValue,
  routineTriggerDrafts,
  routineTriggerDraftValid,
  routineTriggerKinds,
  routineTriggerPresentationValue,
} from "../../lib/routine-triggers";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  formatRoutineExecutionTime,
  type RoutineExecutionView,
  type RoutineScheduleDraft,
  type RoutineSchedulePreset,
  type RoutineView,
  routineIsRunning,
} from "../../lib/routines";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

const RoutineEventFields = lazy(() =>
  import("./routine-event-fields").then((module) => ({ default: module.RoutineEventFields }))
);

const fieldClass =
  "h-9 rounded-[7px] border-[#d9d9d9] bg-background px-2.5 text-[13px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]";
const compactControlClass =
  "inline-flex h-7 min-w-0 items-center justify-between gap-1 rounded-[6px] border border-transparent bg-[#eeeeee] px-2 text-[12px] outline-none hover:bg-[#e7e7e7] focus-visible:border-[#2388ff] focus-visible:ring-2 focus-visible:ring-[#2388ff]/25 data-[state=open]:border-[#2388ff] data-[state=open]:ring-2 data-[state=open]:ring-[#2388ff]/20 dark:bg-[#292929] dark:hover:bg-[#303030]";

const schedulePresets: Array<{ value: RoutineSchedulePreset; label: string }> = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "interval", label: "Interval" },
  { value: "advanced", label: "Advanced" },
  { value: "custom", label: "Custom" },
];

const weekDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const shortWeekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const intervalAmounts: Record<RoutineScheduleDraft["intervalUnit"], number[]> = {
  m: [1, 2, 5, 10, 15, 20, 30, 45],
  h: [1, 2, 3, 4, 6, 8, 12],
  d: [1, 2, 3, 7, 14, 30],
};

const intervalDefault = (unit: RoutineScheduleDraft["intervalUnit"]): number =>
  unit === "m" ? 30 : 1;

const timeLabel = (value: string) => {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return new Date(2026, 0, 1, hour, minute).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
};

const timeOptions = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { value, label: timeLabel(value) };
});
const hourOptions = Array.from({ length: 24 }, (_, hour) => {
  const value = `${String(hour).padStart(2, "0")}:00`;
  return { value, label: timeLabel(value) };
});
const minuteOptions = Array.from({ length: 12 }, (_, index) => ({
  value: String(index * 5),
  label: `:${String(index * 5).padStart(2, "0")}`,
}));

const cloneDefaultSchedule = (): RoutineScheduleDraft => ({
  ...DEFAULT_ROUTINE_SCHEDULE,
  advancedMonths: [...DEFAULT_ROUTINE_SCHEDULE.advancedMonths],
  advancedWeekDays: [...DEFAULT_ROUTINE_SCHEDULE.advancedWeekDays],
  advancedMonthDays: [...DEFAULT_ROUTINE_SCHEDULE.advancedMonthDays],
  advancedTimes: [...DEFAULT_ROUTINE_SCHEDULE.advancedTimes],
});

const scheduleForPreset = (
  preset: RoutineSchedulePreset,
  time = "08:00"
): RoutineScheduleDraft => ({ ...cloneDefaultSchedule(), preset, time });

const changeSchedulePreset = (
  current: RoutineScheduleDraft,
  preset: RoutineSchedulePreset
): RoutineScheduleDraft => {
  const next = scheduleForPreset(preset, current.time || "08:00");
  if (preset === "hourly") next.minute = current.preset === "hourly" ? current.minute : 0;
  if (preset === "weekly") next.weekDay = current.preset === "weekly" ? current.weekDay : 1;
  if (preset === "monthly") next.monthDay = current.preset === "monthly" ? current.monthDay : 1;
  if (preset === "interval" && current.preset === "interval") {
    next.intervalAmount = current.intervalAmount;
    next.intervalUnit = current.intervalUnit;
  }
  if (preset === "advanced") {
    next.advancedMonths = [...current.advancedMonths];
    next.advancedDayMode = current.advancedDayMode;
    next.advancedWeekDays = [...current.advancedWeekDays];
    next.advancedMonthDays = [...current.advancedMonthDays];
    next.advancedTimeMode = current.advancedTimeMode;
    next.advancedTimes = [...current.advancedTimes];
    next.advancedEveryAmount = current.advancedEveryAmount;
    next.advancedEveryUnit = current.advancedEveryUnit;
    next.advancedFromTime = current.advancedFromTime;
    next.advancedToTime = current.advancedToTime;
  }
  if (preset === "custom") {
    next.customSchedule = current.preset === "custom" ? current.customSchedule : "@every 30m";
  }
  return next;
};

function CompactSelect({
  ariaLabel,
  className,
  contentClassName,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  contentClassName?: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string; triggerLabel?: string }>;
  value: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select onValueChange={onValueChange} value={value}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(compactControlClass, "w-auto py-0 shadow-none", className)}
        data-routine-select=""
      >
        <SelectValue>{selected?.triggerLabel ?? selected?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent
        aria-label={ariaLabel}
        className={cn(
          "z-[120] max-h-[300px] min-w-[var(--radix-select-trigger-width)] rounded-[9px] border-[#d6d6d6] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#343434] dark:bg-[#1d1d1d] dark:text-[#f5f5f5]",
          contentClassName
        )}
        position="popper"
        sideOffset={3}
        viewportClassName="h-auto"
      >
        {options.map((option) => (
          <SelectItem
            className="h-8 rounded-[7px] py-0 pl-2 pr-8 text-[12px] data-[highlighted]:bg-accent dark:data-[highlighted]:bg-[#2a2a2a] dark:data-[highlighted]:text-[#f5f5f5] [&>span]:right-2 [&_svg]:size-3"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MultiPicker({
  ariaLabel,
  anyLabel,
  onChange,
  options,
  summary,
  values,
}: {
  ariaLabel: string;
  anyLabel: string;
  onChange: (values: number[]) => void;
  options: Array<{ value: number; label: string }>;
  summary: (values: number[]) => string;
  values: number[];
}) {
  const toggle = (item: number) =>
    onChange(values.includes(item) ? values.filter((value) => value !== item) : [...values, item]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button aria-label={ariaLabel} className={compactControlClass} type="button">
          <span className="max-w-[118px] truncate">
            {values.length === 0 ? anyLabel : summary(values)}
          </span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={ariaLabel}
        className="z-[120] max-h-[280px] w-auto min-w-[160px] overflow-y-auto rounded-[9px] border-[#d6d6d6] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#343434] dark:bg-[#1d1d1d] dark:text-[#f5f5f5]"
        data-routine-popover="multi-picker"
        sideOffset={3}
      >
        <button
          aria-pressed={values.length === 0}
          className="relative flex h-8 w-full items-center rounded-[6px] px-2 pr-7 text-left text-[12px] outline-none hover:bg-accent focus-visible:bg-accent dark:hover:bg-[#2a2a2a] dark:focus-visible:bg-[#2a2a2a]"
          onClick={() => onChange([])}
          type="button"
        >
          {anyLabel}
          {values.length === 0 && <Check className="absolute right-2 size-3.5" />}
        </button>
        {options.map((option) => (
          <button
            aria-pressed={values.includes(option.value)}
            className="relative flex h-8 w-full items-center rounded-[6px] px-2 pr-7 text-left text-[12px] outline-none hover:bg-accent focus-visible:bg-accent dark:hover:bg-[#2a2a2a] dark:focus-visible:bg-[#2a2a2a]"
            key={option.value}
            onClick={() => toggle(option.value)}
            type="button"
          >
            {option.label}
            {values.includes(option.value) && <Check className="absolute right-2 size-3.5" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function StringMultiPicker({
  ariaLabel,
  onChange,
  options,
  values,
}: {
  ariaLabel: string;
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string; group: string }>;
  values: string[];
}) {
  const summary =
    values.length === 0
      ? "Choose an event"
      : values.length === 1
        ? (options.find((option) => option.value === values[0])?.label ?? values[0])
        : `${options.find((option) => option.value === values[0])?.label ?? values[0]} +${values.length - 1}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button aria-label={ariaLabel} className={compactControlClass} type="button">
          <span className="max-w-[154px] truncate">{summary}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={ariaLabel}
        className="max-h-[320px] w-[156px] overflow-y-auto rounded-[9px] border-[#d6d6d6] p-1 dark:border-[#343434] dark:bg-[#1d1d1d] dark:text-[#f5f5f5]"
        data-routine-popover="event-picker"
      >
        {[...new Set(options.map((option) => option.group))].map((group, groupIndex) => (
          <div
            className={cn(
              groupIndex > 0 && "mt-1 border-t border-[#d8d8d8] pt-1 dark:border-[#353535]"
            )}
            key={group}
          >
            <div className="px-2 py-1 text-[11px] text-muted-foreground">{group}</div>
            {options
              .filter((option) => option.group === group)
              .map((option) => {
                const checked = values.includes(option.value);
                return (
                  <button
                    aria-pressed={checked}
                    className="relative flex min-h-7 w-full items-center rounded-[6px] py-1 pl-6 pr-2 text-left text-[12px] outline-none hover:bg-accent focus-visible:bg-accent dark:hover:bg-[#2a2a2a] dark:focus-visible:bg-[#2a2a2a]"
                    key={option.value}
                    onClick={() =>
                      onChange(
                        checked
                          ? values.length > 1
                            ? values.filter((value) => value !== option.value)
                            : values
                          : [...values, option.value]
                      )
                    }
                    type="button"
                  >
                    <span
                      className={cn(
                        "absolute left-2 size-3 rounded-[3px] border border-[#707070]",
                        checked && "border-[#f4f4f4] bg-[#f4f4f4] dark:border-white dark:bg-white"
                      )}
                    >
                      {checked && <Check className="size-3 text-[#171717]" />}
                    </span>
                    {option.label}
                  </button>
                );
              })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const menuContentClass =
  "z-[120] min-w-[180px] overflow-hidden rounded-[9px] border border-[#d6d6d6] bg-popover p-1 text-[12px] text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#3a3a3a]";
const menuItemClass =
  "flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 outline-none data-[highlighted]:bg-accent";

function SlackIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-label="Slack" height={size} role="img" viewBox="0 0 122.8 122.8" width={size}>
      <path
        d="M30.3 77.2a15.2 15.2 0 1 1-15.2-15.1h15.2v15.1Zm7.6 0a15.2 15.2 0 0 1 30.4 0v38a15.2 15.2 0 1 1-30.4 0v-38Z"
        fill="#36C5F0"
      />
      <path
        d="M45.5 30.3a15.2 15.2 0 1 1 15.2-15.2v15.2H45.5Zm0 7.6a15.2 15.2 0 0 1 0 30.4h-38a15.2 15.2 0 1 1 0-30.4h38Z"
        fill="#2EB67D"
      />
      <path
        d="M92.5 45.5a15.2 15.2 0 1 1 15.2 15.2H92.5V45.5Zm-7.6 0a15.2 15.2 0 0 1-30.4 0v-38a15.2 15.2 0 1 1 30.4 0v38Z"
        fill="#ECB22E"
      />
      <path
        d="M77.3 92.5a15.2 15.2 0 1 1-15.2 15.2V92.5h15.2Zm0-7.6a15.2 15.2 0 0 1 0-30.4h38a15.2 15.2 0 1 1 0 30.4h-38Z"
        fill="#E01E5A"
      />
    </svg>
  );
}

function GitHubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-label="GitHub"
      className="text-foreground"
      fill="currentColor"
      height={size}
      role="img"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.2 1.78 1.2 1.04 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.74-1.55-2.57-.3-5.28-1.29-5.28-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.98 10.98 0 0 1 5.76 0c2.19-1.49 3.15-1.18 3.15-1.18.64 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function TeamsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-label="Microsoft Teams" height={size} role="img" viewBox="0 0 24 24" width={size}>
      <path
        clipRule="evenodd"
        d="M15.5 5A3 3 0 0 1 14 7.599V7.5a2 2 0 0 0-2-2H9.541A3 3 0 1 1 15.5 5Zm6.25 1a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm-3.294 11.732A3.25 3.25 0 0 0 23 14.75v-4.361a.889.889 0 0 0-.889-.889h-3.879c.17.294.268.636.268 1V17c0 .248-.015.492-.044.732ZM8.169 19.5A5 5 0 0 0 17.5 17v-6.5a1 1 0 0 0-1-1H14v8a2 2 0 0 1-2 2H8.169Z"
        fill="#5059C9"
        fillRule="evenodd"
      />
      <path
        clipRule="evenodd"
        d="M1 17.5v-10a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1Zm6.75-6.75H9.5v-1.5h-5v1.5h1.75v4.75h1.5v-4.75Z"
        fill="#7B83EB"
        fillRule="evenodd"
      />
    </svg>
  );
}

function LinearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-label="Linear" height={size} role="img" viewBox="0 0 24 24" width={size}>
      <path
        d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
        fill="#5E6AD2"
      />
    </svg>
  );
}

function SentryIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-label="Sentry" height={size} role="img" viewBox="0 0 24 24" width={size}>
      <path
        d="m23.663 19.246-9.72-16.71C13.497 1.798 12.749 1.5 12 1.5s-1.495.444-1.943 1.036l-3.14 5.471.748.444a14.735 14.735 0 0 1 5.682 5.619c1.197 2.071 1.944 4.288 2.094 6.656h-2.243a13.066 13.066 0 0 0-1.794-5.621c-1.047-2.07-2.692-3.697-4.785-4.88l-.749-.443-2.99 5.028.747.444c1.944 1.182 3.29 3.104 3.589 5.323H2.281c-.149 0-.3-.148-.3-.148s-.148-.148 0-.296l1.348-2.367c-.449-.442-1.048-.74-1.646-.886L.337 19.247c-.449.74-.449 1.479 0 2.219.448.738 1.046 1.034 1.943 1.034h6.879v-.886c0-1.627-.449-3.106-1.196-4.586-.599-1.182-1.496-2.07-2.542-2.808l1.047-1.924c1.347 1.034 2.543 2.218 3.439 3.698 1.047 1.773 1.496 3.697 1.496 5.619v.886h5.831v-.886c0-2.957-.747-5.916-2.392-8.577-1.197-2.368-3.141-4.289-5.385-5.768L11.7 3.424c.152-.149.3-.149.3-.149.15 0 .15 0 .299.148l9.721 16.709c.148.146 0 .296 0 .296s-.15.148-.3.148h-2.243v1.775h2.243c.896.147 1.495-.148 1.943-.886.449-.739.449-1.479 0-2.219Z"
        fill="#6E47AE"
      />
    </svg>
  );
}

function PagerDutyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-label="PagerDuty" height={size} role="img" viewBox="0 0 24 24" width={size}>
      <g transform="translate(-2.23 0)">
        <path
          d="M15.59 0H5.65v16.08h3.56V3.39h6.12c2.37 0 4.23 1.28 4.23 3.86 0 2.47-1.67 3.97-4.23 3.97H12.1v3.21h3.56c4.49 0 7.15-2.93 7.15-7.1C22.81 2.97 20.28 0 15.59 0ZM5.65 20.4h3.56V24H5.65Z"
          fill="#06AC38"
        />
      </g>
    </svg>
  );
}

function TimeCadenceSubmenu({
  label,
  preset,
  onAdd,
}: {
  label: string;
  preset: "daily" | "weekdays";
  onAdd: (schedule: RoutineScheduleDraft) => void;
}) {
  return (
    <DropdownMenuPrimitive.Sub>
      <DropdownMenuPrimitive.SubTrigger className={menuItemClass}>
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3 text-muted-foreground" />
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent
          aria-label={`${label} time`}
          className={cn(menuContentClass, "max-h-[320px] min-w-[132px] overflow-y-auto")}
          sideOffset={2}
        >
          {timeOptions.map((option) => (
            <DropdownMenuPrimitive.Item
              className={menuItemClass}
              key={option.value}
              onSelect={() => onAdd(scheduleForPreset(preset, option.value))}
            >
              {option.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Sub>
  );
}

const triggerMenuIcon = (kind: RoutineTriggerKind, size = 16) => {
  switch (kind) {
    case "schedule":
      return <Clock3 className="shrink-0 text-muted-foreground" size={size} />;
    case "slack":
      return <SlackIcon size={size} />;
    case "github":
      return <GitHubIcon size={size} />;
    case "microsoftTeams":
      return <TeamsIcon size={size} />;
    case "linear":
      return <LinearIcon size={size} />;
    case "sentry":
      return <SentryIcon size={size} />;
    case "pagerduty":
      return <PagerDutyIcon size={size} />;
    case "webhook":
      return <Globe2 className="shrink-0 text-muted-foreground" size={size} />;
  }
};

function AddTriggerMenu({
  hasTriggers,
  onAdd,
  onOpenChange,
  open,
}: {
  hasTriggers: boolean;
  onAdd: (trigger: RoutineTriggerDraft) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const onAddSchedule = (schedule: RoutineScheduleDraft) => onAdd({ kind: "schedule", schedule });
  return (
    <DropdownMenuPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          className={cn(
            "h-8 w-full justify-start gap-1.5 rounded-[9px] px-2 text-[12px] font-normal text-muted-foreground",
            hasTriggers && "rounded-t-none border-t border-[#dedede] dark:border-[#343434]"
          )}
          variant="ghost"
        >
          <CirclePlus className="size-3.5" />
          {hasTriggers ? "Add another" : "Add trigger"}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          aria-label="Trigger types"
          className={cn(menuContentClass, "min-w-[200px]")}
          data-routine-popover="add-trigger"
          sideOffset={4}
        >
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={menuItemClass}>
              {triggerMenuIcon("schedule", 18)}
              <span className="flex-1">On a schedule</span>
              <ChevronRight className="size-3 text-muted-foreground" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                aria-label="Cadence"
                className={menuContentClass}
                sideOffset={2}
              >
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAddSchedule(scheduleForPreset("hourly"))}
                >
                  Every hour
                </DropdownMenuPrimitive.Item>
                <TimeCadenceSubmenu label="Every day" onAdd={onAddSchedule} preset="daily" />
                <TimeCadenceSubmenu label="Weekdays" onAdd={onAddSchedule} preset="weekdays" />
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAddSchedule(scheduleForPreset("weekly"))}
                >
                  Every week
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAddSchedule(scheduleForPreset("monthly"))}
                >
                  Every month
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAddSchedule(scheduleForPreset("interval"))}
                >
                  Interval
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAddSchedule(scheduleForPreset("advanced"))}
                >
                  Advanced…
                </DropdownMenuPrimitive.Item>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
          {routineTriggerKinds.slice(1).map((item) => (
            <DropdownMenuPrimitive.Item
              className={menuItemClass}
              key={item.kind}
              onSelect={() =>
                onAdd(
                  defaultRoutineTriggerDraft(item.kind as Exclude<RoutineTriggerKind, "schedule">)
                )
              }
            >
              {triggerMenuIcon(item.kind, 18)}
              {item.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function ScheduleFields({
  value,
  onChange,
}: {
  value: RoutineScheduleDraft;
  onChange: (next: RoutineScheduleDraft) => void;
}) {
  const patch = (change: Partial<RoutineScheduleDraft>) => onChange({ ...value, ...change });
  return (
    <fieldset
      aria-label="Trigger fields"
      className="m-0 flex flex-wrap items-center gap-1 border-0 px-2 pb-2 pt-0.5 text-[12px]"
      data-routine-schedule-editor=""
    >
      <CompactSelect
        ariaLabel="Frequency"
        className="max-w-[112px]"
        contentClassName="min-w-[168px]"
        onValueChange={(preset) =>
          onChange(changeSchedulePreset(value, preset as RoutineSchedulePreset))
        }
        options={schedulePresets}
        value={value.preset}
      />

      {value.preset === "hourly" && (
        <>
          <span className="text-muted-foreground">at</span>
          <CompactSelect
            ariaLabel="Minute"
            onValueChange={(minute) => patch({ minute: Number(minute) })}
            options={minuteOptions}
            value={String(value.minute)}
          />
        </>
      )}
      {(value.preset === "daily" || value.preset === "weekdays") && (
        <>
          <span className="text-muted-foreground">at</span>
          <CompactSelect
            ariaLabel="Time"
            contentClassName="min-w-[158px]"
            onValueChange={(time) => patch({ time })}
            options={timeOptions}
            value={value.time}
          />
        </>
      )}
      {value.preset === "weekly" && (
        <>
          <span className="text-muted-foreground">on</span>
          <CompactSelect
            ariaLabel="Day of week"
            onValueChange={(day) => patch({ weekDay: Number(day) })}
            options={weekDays.map((label, index) => ({ value: String(index), label }))}
            value={String(value.weekDay)}
          />
          <span className="text-muted-foreground">at</span>
          <CompactSelect
            ariaLabel="Time"
            contentClassName="min-w-[158px]"
            onValueChange={(time) => patch({ time })}
            options={timeOptions}
            value={value.time}
          />
        </>
      )}
      {value.preset === "monthly" && (
        <>
          <span className="text-muted-foreground">on the</span>
          <CompactSelect
            ariaLabel="Day of month"
            onValueChange={(day) => patch({ monthDay: Number(day) })}
            options={Array.from({ length: 31 }, (_, index) => ({
              value: String(index + 1),
              label: routineOrdinalLabel(index + 1),
            }))}
            value={String(value.monthDay)}
          />
          <span className="text-muted-foreground">at</span>
          <CompactSelect
            ariaLabel="Time"
            contentClassName="min-w-[158px]"
            onValueChange={(time) => patch({ time })}
            options={timeOptions}
            value={value.time}
          />
        </>
      )}
      {value.preset === "interval" && (
        <>
          <span className="text-muted-foreground">every</span>
          <CompactSelect
            ariaLabel="Interval amount"
            onValueChange={(amount) => patch({ intervalAmount: Number(amount) })}
            options={intervalAmounts[value.intervalUnit].map((amount) => ({
              value: String(amount),
              label: String(amount),
            }))}
            value={String(value.intervalAmount)}
          />
          <CompactSelect
            ariaLabel="Interval unit"
            onValueChange={(unit) => {
              const intervalUnit = unit as RoutineScheduleDraft["intervalUnit"];
              patch({
                intervalUnit,
                intervalAmount: intervalAmounts[intervalUnit].includes(value.intervalAmount)
                  ? value.intervalAmount
                  : intervalDefault(intervalUnit),
              });
            }}
            options={[
              { value: "m", label: "minutes" },
              { value: "h", label: "hours" },
              { value: "d", label: "days" },
            ]}
            value={value.intervalUnit}
          />
        </>
      )}
      {value.preset === "advanced" && (
        <div className="mt-1 grid w-full grid-cols-[38px_1fr] items-center gap-x-1 gap-y-1">
          <span className="text-muted-foreground">Months</span>
          <MultiPicker
            anyLabel="Any month"
            ariaLabel="Months"
            onChange={(advancedMonths) => patch({ advancedMonths })}
            options={months.map((label, index) => ({ value: index + 1, label }))}
            summary={(selected) =>
              selected.map((month) => months[month - 1]?.slice(0, 3)).join(", ")
            }
            values={value.advancedMonths}
          />
          <span className="text-muted-foreground">Days</span>
          <div className="flex flex-wrap gap-1">
            <CompactSelect
              ariaLabel="Days"
              onValueChange={(advancedDayMode) =>
                patch({
                  advancedDayMode: advancedDayMode as RoutineScheduleDraft["advancedDayMode"],
                })
              }
              options={[
                { value: "every-day", label: "Every day" },
                { value: "weekdays", label: "Days of the week" },
                { value: "month-days", label: "Days of the month" },
              ]}
              value={value.advancedDayMode}
            />
            {value.advancedDayMode === "weekdays" && (
              <MultiPicker
                anyLabel="Monday"
                ariaLabel="Days of the week"
                onChange={(advancedWeekDays) =>
                  patch({ advancedWeekDays: advancedWeekDays.length > 0 ? advancedWeekDays : [1] })
                }
                options={weekDays.map((label, index) => ({ value: index, label }))}
                summary={(selected) => selected.map((day) => shortWeekDays[day]).join(", ")}
                values={value.advancedWeekDays}
              />
            )}
            {value.advancedDayMode === "month-days" && (
              <MultiPicker
                anyLabel="1st"
                ariaLabel="Days of the month"
                onChange={(advancedMonthDays) =>
                  patch({
                    advancedMonthDays: advancedMonthDays.length > 0 ? advancedMonthDays : [1],
                  })
                }
                options={Array.from({ length: 31 }, (_, index) => ({
                  value: index + 1,
                  label: routineOrdinalLabel(index + 1),
                }))}
                summary={(selected) => selected.map(routineOrdinalLabel).join(", ")}
                values={value.advancedMonthDays}
              />
            )}
          </div>
          <span className="self-start pt-1.5 text-muted-foreground">Time</span>
          <div className="flex flex-wrap items-center gap-1">
            <CompactSelect
              ariaLabel="Time mode"
              onValueChange={(advancedTimeMode) =>
                patch({
                  advancedTimeMode: advancedTimeMode as RoutineScheduleDraft["advancedTimeMode"],
                })
              }
              options={[
                { value: "at-times", label: "At times" },
                { value: "every", label: "Every" },
              ]}
              value={value.advancedTimeMode}
            />
            {value.advancedTimeMode === "at-times" ? (
              <>
                {value.advancedTimes.map((time, index) => (
                  <CompactSelect
                    ariaLabel={index === 0 ? "Time" : `Time ${index + 1}`}
                    contentClassName="min-w-[158px]"
                    key={time}
                    onValueChange={(nextTime) =>
                      patch({
                        advancedTimes: value.advancedTimes.map((item, itemIndex) =>
                          itemIndex === index ? nextTime : item
                        ),
                      })
                    }
                    options={timeOptions}
                    value={time}
                  />
                ))}
                {value.advancedTimes.length < 8 && (
                  <Button
                    className="h-7 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground"
                    onClick={() => patch({ advancedTimes: [...value.advancedTimes, "08:00"] })}
                    variant="ghost"
                  >
                    <CirclePlus className="size-3" /> Add time
                  </Button>
                )}
              </>
            ) : (
              <>
                <CompactSelect
                  ariaLabel="Interval amount"
                  onValueChange={(amount) => patch({ advancedEveryAmount: Number(amount) })}
                  options={intervalAmounts[value.advancedEveryUnit].map((amount) => ({
                    value: String(amount),
                    label: String(amount),
                  }))}
                  value={String(value.advancedEveryAmount)}
                />
                <CompactSelect
                  ariaLabel="Interval unit"
                  onValueChange={(unit) => {
                    const advancedEveryUnit = unit as RoutineScheduleDraft["advancedEveryUnit"];
                    patch({
                      advancedEveryUnit,
                      advancedEveryAmount: intervalAmounts[advancedEveryUnit].includes(
                        value.advancedEveryAmount
                      )
                        ? value.advancedEveryAmount
                        : intervalDefault(advancedEveryUnit),
                    });
                  }}
                  options={[
                    { value: "m", label: "minutes" },
                    { value: "h", label: "hours" },
                    { value: "d", label: "days" },
                  ]}
                  value={value.advancedEveryUnit}
                />
                <span className="text-muted-foreground">between</span>
                <CompactSelect
                  ariaLabel="From hour"
                  onValueChange={(advancedFromTime) => patch({ advancedFromTime })}
                  options={hourOptions}
                  value={value.advancedFromTime}
                />
                <span className="text-muted-foreground">and</span>
                <CompactSelect
                  ariaLabel="To hour"
                  onValueChange={(advancedToTime) => patch({ advancedToTime })}
                  options={hourOptions}
                  value={value.advancedToTime}
                />
              </>
            )}
          </div>
        </div>
      )}
      {value.preset === "custom" && (
        <Input
          aria-label="Schedule"
          className="h-8 min-w-[145px] flex-1 rounded-[7px] border-[#d9d9d9] bg-background px-2 text-[12px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
          onChange={(event) => patch({ customSchedule: event.target.value })}
          value={value.customSchedule}
        />
      )}
    </fieldset>
  );
}

const triggerGlyph = (value: RoutineTriggerDraft) =>
  value.kind === "unsupported" ? (
    <Radio className="size-3.5 text-muted-foreground" />
  ) : (
    triggerMenuIcon(value.kind)
  );

function TriggerCard({
  index,
  value,
  expanded,
  onChange,
  onExpand,
  onRemove,
}: {
  index: number;
  value: RoutineTriggerDraft;
  expanded: boolean;
  onChange: (next: RoutineTriggerDraft) => void;
  onExpand: () => void;
  onRemove: () => void;
}) {
  const description = describeRoutineTrigger(value);
  return (
    <li
      className={cn(
        "group/schedule",
        index > 0 && "border-t border-[#dedede] dark:border-[#343434]"
      )}
    >
      <div className="flex min-h-10 items-center gap-2 px-2">
        <button
          aria-expanded={expanded}
          aria-label={description}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-[7px] px-1 py-2 text-left outline-none transition-colors hover:bg-[#f1f1f1] focus-visible:bg-[#f1f1f1] dark:hover:bg-[#292929] dark:focus-visible:bg-[#292929]"
          disabled={value.kind === "unsupported"}
          onClick={onExpand}
          type="button"
        >
          <span className="grid size-3.5 shrink-0 place-items-center">{triggerGlyph(value)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{description}</span>
        </button>
        <Button
          aria-label={`Remove trigger: ${description}`}
          className="size-7 rounded-full text-muted-foreground opacity-0 transition-opacity group-hover/schedule:opacity-100 hover:opacity-100 focus-visible:opacity-100"
          onClick={onRemove}
          size="icon-sm"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {expanded && value.kind === "schedule" && (
        <ScheduleFields
          onChange={(schedule) => onChange({ kind: "schedule", schedule })}
          value={value.schedule}
        />
      )}
      {expanded && value.kind !== "schedule" && value.kind !== "unsupported" && (
        <Suspense
          fallback={<div aria-label="Loading trigger fields" className="h-8" role="status" />}
        >
          <RoutineEventFields
            EventPicker={StringMultiPicker}
            onChange={onChange}
            SelectControl={CompactSelect}
            value={value}
          />
        </Suspense>
      )}
    </li>
  );
}

const executionStatus = (execution: RoutineExecutionView): string => {
  switch (execution.status) {
    case "queued":
    case "running":
    case "waiting_approval":
      return "Running";
    case "completed":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
  }
};

function RunHistory({ executions }: { executions: RoutineExecutionView[] }) {
  if (executions.length === 0) {
    return <div className="px-2 py-2 text-[12px] text-muted-foreground">No runs yet</div>;
  }
  return (
    <ul aria-label="Run history">
      {executions.map((execution) => {
        const running = isTransientRoutineExecutionStatus(execution.status);
        return (
          <li
            aria-label={execution.kind === "test" ? "Manual run" : "Scheduled run"}
            className="flex min-h-8 items-center gap-2 py-1 text-[12px]"
            data-routine-execution-status={execution.status}
            key={execution.id}
          >
            <span className="min-w-0 flex-1 truncate">{formatRoutineExecutionTime(execution)}</span>
            <span
              aria-label={executionStatus(execution)}
              className={cn(
                "grid size-5 shrink-0 place-items-center",
                execution.status === "completed" && "text-[#2f8a62]",
                execution.status === "failed" && "text-destructive",
                !running &&
                  execution.status !== "completed" &&
                  execution.status !== "failed" &&
                  "text-muted-foreground"
              )}
              role="img"
            >
              {running ? (
                <LoaderCircle className="size-3.5 animate-spin text-[#2c8ed6]" />
              ) : execution.status === "completed" ? (
                <Check className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface RoutineDraft {
  name: string;
  prompt: string;
  enabled: boolean;
  triggers: RoutineTriggerDraft[];
}

interface RoutineSaveContext {
  key: string;
  ownerId: string;
  ownerKind: "bot" | "group";
  routine: RoutineView | null;
  draft: RoutineDraft;
  dirty: boolean;
  saving: boolean;
  pending: RoutineDraft | null;
  attached: boolean;
}

const newDraft = (): RoutineDraft => ({
  name: "",
  prompt: "",
  enabled: true,
  triggers: [],
});

const draftFromRoutine = (routine: RoutineView): RoutineDraft => ({
  name: routine.name,
  prompt: routine.prompt,
  enabled: routine.enabled,
  triggers: routineTriggerDrafts(routine),
});

const draftValid = (draft: RoutineDraft) =>
  draft.name.trim().length > 0 &&
  draft.prompt.trim().length > 0 &&
  draft.triggers.length > 0 &&
  draft.triggers.length <= 8 &&
  draft.triggers.every(routineTriggerDraftValid) &&
  routineDraftTriggerValue(draft.triggers) !== null;

export function RoutineEditor({
  active,
  ownerId,
  ownerKind,
  routineId,
  onDeleted,
}: {
  active: boolean;
  ownerId: string;
  ownerKind: "bot" | "group";
  routineId: string | null;
  onDeleted: () => void;
}) {
  const [routine, setRoutine] = useState<RoutineView | null>(null);
  const [draft, setDraft] = useState<RoutineDraft>(newDraft);
  const [executions, setExecutions] = useState<RoutineExecutionView[]>([]);
  const [expandedTrigger, setExpandedTrigger] = useState<number | null>(null);
  const [addTriggerOpen, setAddTriggerOpen] = useState(false);
  const [loading, setLoading] = useState(Boolean(routineId));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runError, setRunError] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toggleSaving, setToggleSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextKey = `${ownerKind}:${ownerId}:${routineId ?? "new"}`;
  const contextRef = useRef<RoutineSaveContext | null>(null);
  if (!contextRef.current || contextRef.current.key !== contextKey) {
    if (contextRef.current) contextRef.current.attached = false;
    contextRef.current = {
      key: contextKey,
      ownerId,
      ownerKind,
      routine: null,
      draft: newDraft(),
      dirty: false,
      saving: false,
      pending: null,
      attached: active,
    };
  }
  const saveContext = contextRef.current;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(Boolean(routineId));
    setSaveState("idle");
    setRoutine(null);
    saveContext.routine = null;
    setExecutions([]);
    setDirty(false);
    setToggleSaving(false);
    const initial = newDraft();
    setDraft(initial);
    saveContext.draft = initial;
    saveContext.dirty = false;
    setExpandedTrigger(null);
    setAddTriggerOpen(false);
    if (!routineId) return () => undefined;
    void Promise.all([api.routine(routineId), api.routineExecutions(routineId)]).then(
      ([loaded, history]) => {
        if (cancelled) return;
        const next = draftFromRoutine(loaded);
        saveContext.routine = loaded;
        saveContext.draft = next;
        saveContext.dirty = false;
        setRoutine(loaded);
        setDraft(next);
        setExecutions(history);
        setDirty(false);
        setLoading(false);
      },
      () => {
        if (!cancelled) {
          setSaveState("error");
          setLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [active, routineId, saveContext]);

  const persist = useCallback(async function save(
    context: RoutineSaveContext,
    value: RoutineDraft
  ): Promise<void> {
    if (!draftValid(value)) return;
    if (context.saving) {
      context.pending = value;
      return;
    }
    const trigger = routineDraftTriggerValue(value.triggers);
    if (!trigger) return;
    context.saving = true;
    if (context.attached) setSaveState("saving");
    try {
      const presentation = routineTriggerPresentationValue(value.triggers);
      const current = context.routine;
      const update = (base: RoutineView) =>
        api.updateRoutine(base.id, {
          name: value.name.trim(),
          prompt: value.prompt.trim(),
          trigger,
          presentation,
          expectedRevision: base.revision,
        });
      let saved: RoutineView;
      if (!current) {
        saved = await api.createRoutine(context.ownerId, context.ownerKind, {
          name: value.name.trim(),
          prompt: value.prompt.trim(),
          trigger,
          presentation,
          enabled: value.enabled,
        });
      } else {
        try {
          saved = await update(current);
        } catch (error) {
          if (!(error instanceof ClientError) || error.status !== 409) throw error;
          const latest = await api.routine(current.id);
          context.routine = latest;
          saved = await update(latest);
        }
      }
      context.routine = saved;
      if (context.attached) setRoutine(saved);
      if (context.draft === value) {
        context.dirty = false;
        if (context.attached) setDirty(false);
      }
      if (context.attached) setSaveState("saved");
    } catch {
      if (context.attached) setSaveState("error");
    } finally {
      context.saving = false;
      const pending = context.pending;
      context.pending = null;
      if (pending) void save(context, pending);
    }
  }, []);

  const queue = useCallback(
    (next: RoutineDraft, immediate = false) => {
      const context = contextRef.current;
      if (!context) return;
      context.draft = next;
      context.dirty = true;
      setDraft(next);
      setDirty(true);
      setRunError(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (!draftValid(next)) {
        setSaveState("idle");
        return;
      }
      if (immediate) void persist(context, next);
      else {
        timer.current = setTimeout(() => {
          timer.current = null;
          void persist(context, context.draft);
        }, 550);
      }
    },
    [persist]
  );

  useEffect(() => {
    const current = routine?.id;
    if (!active || !current) return;
    let stopped = false;
    let pollTimer: number | null = null;
    const poll = async () => {
      if (document.hidden) {
        if (!stopped) pollTimer = window.setTimeout(() => void poll(), 1_500);
        return;
      }
      try {
        const history = await api.routineExecutions(current);
        if (!stopped) setExecutions(history);
      } catch {
        // Keep the last durable history visible through transient refresh failures.
      } finally {
        if (!stopped) pollTimer = window.setTimeout(() => void poll(), 1_500);
      }
    };
    pollTimer = window.setTimeout(() => void poll(), 1_500);
    return () => {
      stopped = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [active, routine?.id]);

  useEffect(() => {
    saveContext.attached = active;
    return () => {
      saveContext.attached = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (saveContext.dirty && draftValid(saveContext.draft)) {
        void persist(saveContext, saveContext.draft);
      }
    };
  }, [active, persist, saveContext]);

  const running = routine
    ? routineIsRunning({ ...routine, latestExecution: executions[0] ?? routine.latestExecution })
    : false;
  const valid = draftValid(draft);

  const toggleActive = (enabled: boolean) => {
    const context = contextRef.current;
    if (!context) return;
    const next = { ...draft, enabled };
    if (!context.routine) {
      queue(next, true);
      return;
    }
    context.draft = next;
    setDraft(next);
    setToggleSaving(true);
    const base = context.routine;
    const commit = async () => {
      try {
        return await api.setRoutineEnabled(base, enabled);
      } catch (error) {
        if (!(error instanceof ClientError) || error.status !== 409) throw error;
        const latest = await api.routine(base.id);
        context.routine = latest;
        return latest.enabled === enabled ? latest : api.setRoutineEnabled(latest, enabled);
      }
    };
    void commit()
      .then((saved) => {
        context.routine = saved;
        if (context.attached) setRoutine(saved);
        if (context.draft === next) {
          const confirmed = { ...next, enabled: saved.enabled };
          context.draft = confirmed;
          if (context.attached) setDraft(confirmed);
        }
      })
      .catch(() => {
        if (context.draft === next) {
          const rolledBack = { ...next, enabled: base.enabled };
          context.draft = rolledBack;
          if (context.attached) setDraft(rolledBack);
        }
        if (context.attached) setSaveState("error");
      })
      .finally(() => {
        if (context.attached) setToggleSaving(false);
      });
  };

  if (loading) {
    return (
      <div className="grid size-full place-items-center pt-10">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div
      className="size-full overflow-y-auto px-3 pb-8 pt-[42px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-150"
      data-routine-editor=""
    >
      <div className="flex min-w-0 items-center gap-2" data-routine-actions="">
        <div className="flex min-w-0 items-center gap-1.5">
          <Switch
            aria-label="Active"
            checked={draft.enabled}
            className="h-4 w-7 data-[state=checked]:bg-[#070707] [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3 dark:data-[state=checked]:bg-[#626262]"
            disabled={toggleSaving}
            onCheckedChange={toggleActive}
          />
          <span className="text-[13px]">Active</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            className="h-8 w-[62px] rounded-[8px] px-2 text-[12px] font-normal"
            onClick={() => (routine ? setDeleteOpen(true) : onDeleted())}
            variant="secondary"
          >
            Delete
          </Button>
          <Button
            className={cn(
              "h-8 rounded-[8px] px-2 text-[12px] font-normal transition-[width,background-color,color]",
              running ? "w-[84px]" : "w-[62px]"
            )}
            disabled={!routine || !valid || dirty || running || saveState === "saving"}
            onClick={() => {
              if (!routine) return;
              setRunError(false);
              void api.runRoutineNow(routine.id).then(
                (execution) => setExecutions((current) => [execution, ...current]),
                () => setRunError(true)
              );
            }}
            title={!routine ? "Available after the routine is saved" : undefined}
          >
            {running ? "Running…" : "Test run"}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-4">
        <div className="grid gap-[3px]">
          <Label
            className="pl-2 text-[12px] font-normal text-muted-foreground"
            htmlFor="routine-name"
          >
            Name
          </Label>
          <Input
            className={fieldClass}
            id="routine-name"
            maxLength={80}
            onChange={(event) => queue({ ...draft, name: event.target.value })}
            placeholder="Name this routine"
            value={draft.name}
          />
        </div>
        <div className="grid gap-[3px]">
          <Label
            className="pl-2 text-[12px] font-normal text-muted-foreground"
            htmlFor="routine-instruction"
          >
            Instruction
          </Label>
          <Textarea
            className="min-h-[68px] resize-y rounded-[7px] border-[#d9d9d9] px-2.5 py-2 text-[13px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id="routine-instruction"
            maxLength={20_000}
            onChange={(event) => queue({ ...draft, prompt: event.target.value })}
            placeholder="What should this routine do each time it runs?"
            value={draft.prompt}
          />
        </div>
        <div className="grid gap-[5px]">
          <Label className="pl-2 text-[12px] font-normal text-muted-foreground">When to run</Label>
          <div className="rounded-[10px] border border-[#dedede] dark:border-[#343434]">
            <ul aria-label="Triggers">
              {draft.triggers.map((trigger, index) => (
                <TriggerCard
                  expanded={expandedTrigger === index}
                  index={index}
                  key={`${trigger.kind}-${index}`}
                  onChange={(next) => {
                    const triggers = draft.triggers.map((item, itemIndex) =>
                      itemIndex === index ? next : item
                    );
                    queue({ ...draft, triggers });
                  }}
                  onExpand={() =>
                    setExpandedTrigger((current) => (current === index ? null : index))
                  }
                  onRemove={() => {
                    const triggers = draft.triggers.filter((_, itemIndex) => itemIndex !== index);
                    setExpandedTrigger(null);
                    queue({ ...draft, triggers }, true);
                  }}
                  value={trigger}
                />
              ))}
            </ul>
            {draft.triggers.length < 8 && (
              <div
                className={cn(
                  expandedTrigger !== null &&
                    "h-0 overflow-hidden opacity-0 focus-within:h-8 focus-within:overflow-visible focus-within:opacity-100"
                )}
              >
                <AddTriggerMenu
                  hasTriggers={draft.triggers.length > 0}
                  onAdd={(trigger) => {
                    const triggers = [...draft.triggers, trigger];
                    setExpandedTrigger(triggers.length - 1);
                    queue({ ...draft, triggers });
                  }}
                  onOpenChange={setAddTriggerOpen}
                  open={addTriggerOpen}
                />
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-1">
          <Label className="pl-2 text-[12px] font-normal text-muted-foreground">Run history</Label>
          <RunHistory executions={executions} />
        </div>
        <div className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">
          {saveState === "saving"
            ? "Saving…"
            : saveState === "error"
              ? "Couldn't save this routine."
              : runError
                ? "Couldn't start a test run."
                : !routine && valid
                  ? "Saving…"
                  : !routine
                    ? ""
                    : ""}
        </div>
      </div>

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{draft.name || "this routine"}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This routine will stop running and disappear from this Bot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const context = contextRef.current;
                const current = context?.routine ?? routine;
                if (!current) return;
                const remove = async () => {
                  try {
                    await api.deleteRoutine(current);
                  } catch (error) {
                    if (!(error instanceof ClientError) || error.status !== 409) throw error;
                    const latest = await api.routine(current.id);
                    if (context) context.routine = latest;
                    await api.deleteRoutine(latest);
                  }
                  onDeleted();
                };
                void remove().catch(() => setSaveState("error"));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
