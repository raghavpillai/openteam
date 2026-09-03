import { routineOrdinalLabel } from "@openteam/product-core/routines";
import { isTransientRoutineExecutionStatus } from "@openteam/product-core/statuses";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Clock3,
  LoaderCircle,
  Pause,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClientError } from "../../client/http";
import { api } from "../../client/openteam-api";
import { cn } from "../../lib/cn";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineSchedule,
  formatRoutineExecutionTime,
  type RoutineExecutionView,
  type RoutineScheduleDraft,
  type RoutineSchedulePreset,
  type RoutineView,
  routineDraftValid,
  routineIsRunning,
  routinePresentationValue,
  routineScheduleDrafts,
  routineScheduleValue,
  routineTriggerValue,
} from "../../lib/routines";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

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
  m: [5, 10, 15, 20, 30, 45],
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
    next.customSchedule =
      current.preset === "custom" ? current.customSchedule : routineScheduleValue(current);
  }
  return next;
};

const nextAdvancedTime = (times: readonly string[]): string => {
  const latest = times.at(-1) ?? "08:00";
  const [hour = 8, minute = 0] = latest.split(":").map(Number);
  const nextMinutes = (((hour * 60 + minute + 60) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(nextMinutes / 60)).padStart(2, "0")}:${String(nextMinutes % 60).padStart(2, "0")}`;
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
  emptyOptionLabel,
  onChange,
  options,
  triggerLabel,
  values,
}: {
  ariaLabel: string;
  emptyOptionLabel?: string;
  onChange: (values: number[]) => void;
  options: Array<{ value: number; label: string }>;
  triggerLabel: string;
  values: number[];
}) {
  const toggle = (item: number) =>
    onChange(values.includes(item) ? values.filter((value) => value !== item) : [...values, item]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button aria-label={ariaLabel} className={compactControlClass} type="button">
          <span className="max-w-[118px] truncate">{triggerLabel}</span>
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
        {emptyOptionLabel && (
          <button
            aria-pressed={values.length === 0}
            className="relative flex h-8 w-full items-center rounded-[6px] px-2 pr-7 text-left text-[12px] outline-none hover:bg-accent focus-visible:bg-accent dark:hover:bg-[#2a2a2a] dark:focus-visible:bg-[#2a2a2a]"
            onClick={() => onChange([])}
            type="button"
          >
            {emptyOptionLabel}
            {values.length === 0 && <Check className="absolute right-2 size-3.5" />}
          </button>
        )}
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

const menuContentClass =
  "z-[120] min-w-[180px] overflow-hidden rounded-[9px] border border-[#d6d6d6] bg-popover p-1 text-[12px] text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#3a3a3a]";
const menuItemClass =
  "flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 outline-none data-[highlighted]:bg-accent";

function AddScheduleMenu({
  hasSchedules,
  onAdd,
  onOpenChange,
  open,
}: {
  hasSchedules: boolean;
  onAdd: (schedule: RoutineScheduleDraft) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            "h-8 w-full justify-start gap-1.5 rounded-[9px] px-2 text-[12px] font-normal text-muted-foreground",
            hasSchedules && "rounded-t-none border-t border-[#dedede] dark:border-[#343434]"
          )}
          variant="ghost"
        >
          <CirclePlus className="size-3.5" />
          {hasSchedules ? "Add another" : "Add trigger"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label="Trigger source"
        className={cn(menuContentClass, "min-w-[200px]")}
        data-routine-popover="add-trigger"
        sideOffset={4}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={menuItemClass}>
            <Clock3 className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">On a schedule</span>
            <ChevronRight className="size-3 text-muted-foreground" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            aria-label="Cadence"
            className={menuContentClass}
            data-routine-popover="add-schedule"
          >
            {schedulePresets
              .filter(({ value }) => value !== "custom")
              .map(({ value, label }) => (
                <DropdownMenuItem
                  className={menuItemClass}
                  key={value}
                  onSelect={() => onAdd(scheduleForPreset(value))}
                >
                  {value === "advanced" ? "Advanced…" : label}
                </DropdownMenuItem>
              ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
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
            ariaLabel="Months"
            emptyOptionLabel="Any month"
            onChange={(advancedMonths) => patch({ advancedMonths })}
            options={months.map((label, index) => ({ value: index + 1, label }))}
            triggerLabel="Months"
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
                ariaLabel="Days of the week"
                onChange={(advancedWeekDays) =>
                  patch({ advancedWeekDays: advancedWeekDays.length > 0 ? advancedWeekDays : [1] })
                }
                options={weekDays.map((label, index) => ({ value: index, label }))}
                triggerLabel="Days of the week"
                values={value.advancedWeekDays}
              />
            )}
            {value.advancedDayMode === "month-days" && (
              <MultiPicker
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
                triggerLabel="Days of the month"
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
                  <span className="inline-flex items-center gap-0.5" key={`advanced-time-${time}`}>
                    <CompactSelect
                      ariaLabel={index === 0 ? "Time" : `Time ${index + 1}`}
                      contentClassName="min-w-[158px]"
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
                    {index > 0 && (
                      <Button
                        aria-label={`Remove ${timeLabel(time)}`}
                        className="size-7 rounded-full text-muted-foreground"
                        onClick={() =>
                          patch({
                            advancedTimes: value.advancedTimes.filter(
                              (_, itemIndex) => itemIndex !== index
                            ),
                          })
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <X className="size-3" />
                      </Button>
                    )}
                  </span>
                ))}
                {value.advancedTimes.length < 8 && (
                  <Button
                    className="h-7 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground"
                    onClick={() =>
                      patch({
                        advancedTimes: [
                          ...value.advancedTimes,
                          nextAdvancedTime(value.advancedTimes),
                        ],
                      })
                    }
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

function ScheduleCard({
  index,
  value,
  expanded,
  onChange,
  onExpand,
  onRemove,
}: {
  index: number;
  value: RoutineScheduleDraft;
  expanded: boolean;
  onChange: (next: RoutineScheduleDraft) => void;
  onExpand: () => void;
  onRemove: () => void;
}) {
  const description = describeRoutineSchedule(value);
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
          onClick={onExpand}
          type="button"
        >
          <span className="grid size-3.5 shrink-0 place-items-center">
            <Clock3 className="size-3.5 text-muted-foreground" />
          </span>
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
      {expanded && <ScheduleFields onChange={onChange} value={value} />}
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

function RunHistory({
  executions,
  hideTransient,
}: {
  executions: RoutineExecutionView[];
  hideTransient: boolean;
}) {
  const visibleExecutions = hideTransient
    ? executions.filter((execution) => !isTransientRoutineExecutionStatus(execution.status))
    : executions;
  if (visibleExecutions.length === 0) {
    return <div className="px-2 py-2 text-[12px] text-muted-foreground">No runs yet</div>;
  }
  return (
    <ul aria-label="Run history">
      {visibleExecutions.map((execution) => {
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
  schedules: Array<{ id: string; schedule: RoutineScheduleDraft }>;
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
  schedules: [],
});

let nextScheduleDraftId = 0;
const scheduleDraftItem = (schedule: RoutineScheduleDraft) => ({
  id: `routine-schedule-${nextScheduleDraftId++}`,
  schedule,
});

const draftFromRoutine = (routine: RoutineView): RoutineDraft => ({
  name: routine.name,
  prompt: routine.prompt,
  enabled: routine.enabled,
  schedules: routineScheduleDrafts(routine).map(scheduleDraftItem),
});

const draftValid = (draft: RoutineDraft) =>
  draft.name.trim().length > 0 &&
  draft.prompt.trim().length > 0 &&
  draft.schedules.length > 0 &&
  draft.schedules.length <= 8 &&
  draft.schedules.every(({ schedule }) =>
    routineDraftValid({ name: draft.name, prompt: draft.prompt, schedule })
  );

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
  const [expandedSchedule, setExpandedSchedule] = useState<number | null>(null);
  const [addScheduleOpen, setAddScheduleOpen] = useState(false);
  const [loading, setLoading] = useState(Boolean(routineId));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runError, setRunError] = useState(false);
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
    setExpandedSchedule(null);
    setAddScheduleOpen(false);
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
    const schedules = value.schedules.map(({ schedule }) => schedule);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const trigger = routineTriggerValue(schedules, timeZone);
    context.saving = true;
    if (context.attached) setSaveState("saving");
    try {
      const presentation = routinePresentationValue(schedules);
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

  const deleteRoutine = async () => {
    const context = contextRef.current;
    const current = context?.routine ?? routine;
    if (!current) {
      onDeleted();
      return;
    }
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
            onClick={() => void deleteRoutine().catch(() => setSaveState("error"))}
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
              {draft.schedules.map((item, index) => (
                <ScheduleCard
                  expanded={expandedSchedule === index}
                  index={index}
                  key={item.id}
                  onChange={(next) => {
                    const schedules = draft.schedules.map((schedule, itemIndex) =>
                      itemIndex === index ? { ...schedule, schedule: next } : schedule
                    );
                    queue({ ...draft, schedules });
                  }}
                  onExpand={() =>
                    setExpandedSchedule((current) => (current === index ? null : index))
                  }
                  onRemove={() => {
                    const schedules = draft.schedules.filter((_, itemIndex) => itemIndex !== index);
                    setExpandedSchedule(null);
                    queue({ ...draft, schedules }, true);
                  }}
                  value={item.schedule}
                />
              ))}
            </ul>
            {draft.schedules.length < 8 && (
              <div
                className={cn(
                  expandedSchedule !== null &&
                    "h-0 overflow-hidden opacity-0 focus-within:h-8 focus-within:overflow-visible focus-within:opacity-100"
                )}
              >
                <AddScheduleMenu
                  hasSchedules={draft.schedules.length > 0}
                  onAdd={(schedule) => {
                    const schedules = [...draft.schedules, scheduleDraftItem(schedule)];
                    setExpandedSchedule(schedules.length - 1);
                    queue({ ...draft, schedules });
                  }}
                  onOpenChange={setAddScheduleOpen}
                  open={addScheduleOpen}
                />
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-1">
          <Label className="pl-2 text-[12px] font-normal text-muted-foreground">Run history</Label>
          <RunHistory executions={executions} hideTransient={draft.schedules.length > 1} />
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
    </div>
  );
}
