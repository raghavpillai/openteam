import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlus,
  Clock3,
  LoaderCircle,
  Pause,
  Plus,
  X,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive, Select as SelectPrimitive } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { cn } from "../../lib/cn";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineSchedule,
  type RoutineExecutionView,
  type RoutineScheduleDraft,
  type RoutineSchedulePreset,
  type RoutineView,
  routineDraftValid,
  routineIsRunning,
  routinePresentationValue,
  routineScheduleValue,
  routineScheduleDrafts,
  routineTriggerValue,
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
const intervalAmounts = [5, 10, 15, 20, 30, 45];

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

const ordinal = (value: number) => {
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
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <SelectPrimitive.Root onValueChange={onValueChange} value={value}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(compactControlClass, className)}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          aria-label={ariaLabel}
          className={cn(
            "z-[120] max-h-[300px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[8px] border border-[#d6d6d6] bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#3a3a3a]",
            contentClassName
          )}
          position="popper"
          sideOffset={3}
        >
          <SelectPrimitive.ScrollUpButton className="grid h-5 place-items-center">
            <ChevronDown className="size-3 rotate-180" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                className="relative flex h-8 cursor-default select-none items-center rounded-[6px] px-2 pr-7 text-[12px] outline-none data-[highlighted]:bg-accent"
                key={option.value}
                value={option.value}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="grid h-5 place-items-center">
            <ChevronDown className="size-3" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
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
    onChange(
      values.includes(item) ? values.filter((value) => value !== item) : [...values, item]
    );
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button aria-label={ariaLabel} className={compactControlClass} type="button">
          <span className="max-w-[118px] truncate">{values.length === 0 ? anyLabel : summary(values)}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          className="z-[120] max-h-[280px] min-w-[150px] overflow-y-auto rounded-[8px] border border-[#d6d6d6] bg-popover p-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#3a3a3a]"
          sideOffset={3}
        >
          <DropdownMenuPrimitive.CheckboxItem
            checked={values.length === 0}
            className="relative flex h-8 items-center rounded-[6px] px-2 pr-7 text-[12px] outline-none data-[highlighted]:bg-accent"
            onCheckedChange={() => onChange([])}
            onSelect={(event) => event.preventDefault()}
          >
            {anyLabel}
            <DropdownMenuPrimitive.ItemIndicator className="absolute right-2">
              <Check className="size-3.5" />
            </DropdownMenuPrimitive.ItemIndicator>
          </DropdownMenuPrimitive.CheckboxItem>
          {options.map((option) => (
            <DropdownMenuPrimitive.CheckboxItem
              checked={values.includes(option.value)}
              className="relative flex h-8 items-center rounded-[6px] px-2 pr-7 text-[12px] outline-none data-[highlighted]:bg-accent"
              key={option.value}
              onCheckedChange={() => toggle(option.value)}
              onSelect={(event) => event.preventDefault()}
            >
              {option.label}
              <DropdownMenuPrimitive.ItemIndicator className="absolute right-2">
                <Check className="size-3.5" />
              </DropdownMenuPrimitive.ItemIndicator>
            </DropdownMenuPrimitive.CheckboxItem>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

const menuContentClass =
  "z-[120] min-w-[180px] overflow-hidden rounded-[9px] border border-[#d6d6d6] bg-popover p-1 text-[12px] text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#3a3a3a]";
const menuItemClass =
  "flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 outline-none data-[highlighted]:bg-accent";

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
    <DropdownMenuPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DropdownMenuPrimitive.Trigger asChild>
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
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          aria-label="Trigger types"
          className={menuContentClass}
          sideOffset={4}
        >
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={menuItemClass}>
              <Clock3 className="size-3.5 text-muted-foreground" />
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
                  onSelect={() => onAdd(scheduleForPreset("hourly"))}
                >
                  Every hour
                </DropdownMenuPrimitive.Item>
                <TimeCadenceSubmenu label="Every day" onAdd={onAdd} preset="daily" />
                <TimeCadenceSubmenu label="Weekdays" onAdd={onAdd} preset="weekdays" />
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAdd(scheduleForPreset("weekly"))}
                >
                  Every week
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAdd(scheduleForPreset("monthly"))}
                >
                  Every month
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAdd(scheduleForPreset("interval"))}
                >
                  Interval
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={() => onAdd(scheduleForPreset("advanced"))}
                >
                  Advanced…
                </DropdownMenuPrimitive.Item>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
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
    <div
      aria-label="Trigger fields"
      className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-0.5 text-[12px]"
      data-routine-schedule-editor=""
      role="group"
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
              label: ordinal(index + 1),
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
            options={intervalAmounts.map((amount) => ({
              value: String(amount),
              label: String(amount),
            }))}
            value={String(value.intervalAmount)}
          />
          <CompactSelect
            ariaLabel="Interval unit"
            onValueChange={(unit) =>
              patch({ intervalUnit: unit as RoutineScheduleDraft["intervalUnit"] })
            }
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
            summary={(selected) => selected.map((month) => months[month - 1]?.slice(0, 3)).join(", ")}
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
                  patch({ advancedMonthDays: advancedMonthDays.length > 0 ? advancedMonthDays : [1] })
                }
                options={Array.from({ length: 31 }, (_, index) => ({
                  value: index + 1,
                  label: ordinal(index + 1),
                }))}
                summary={(selected) => selected.map(ordinal).join(", ")}
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
                    key={`${index}-${time}`}
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
                    onClick={() =>
                      patch({ advancedTimes: [...value.advancedTimes, "08:00"] })
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
                  options={intervalAmounts.map((amount) => ({
                    value: String(amount),
                    label: String(amount),
                  }))}
                  value={String(value.advancedEveryAmount)}
                />
                <CompactSelect
                  ariaLabel="Interval unit"
                  onValueChange={(unit) =>
                    patch({ advancedEveryUnit: unit as RoutineScheduleDraft["advancedEveryUnit"] })
                  }
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
    </div>
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
  return (
    <div
      className={cn("group/schedule", index > 0 && "border-t border-[#dedede] dark:border-[#343434]")}
      role="listitem"
    >
      <div className="flex min-h-10 items-center gap-2 px-2">
        <button
          aria-expanded={expanded}
          aria-label={describeRoutineSchedule(value)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left outline-none"
          onClick={onExpand}
          type="button"
        >
          <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {describeRoutineSchedule(value)}
          </span>
        </button>
        <Button
          aria-label={`Remove trigger: ${describeRoutineSchedule(value)}`}
          className="size-7 rounded-full text-muted-foreground opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          onClick={onRemove}
          size="icon-sm"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {expanded && <ScheduleFields onChange={onChange} value={value} />}
    </div>
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

const executionTime = (execution: RoutineExecutionView): string => {
  const when = new Date(execution.completedAt ?? execution.startedAt ?? execution.createdAt);
  const now = new Date();
  const elapsed = now.getTime() - when.getTime();
  if (elapsed >= 0 && elapsed < 90_000) return "Just now";
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThen = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (startThen === startToday) return `Today at ${time}`;
  if (startThen === startToday - 86_400_000) return `Yesterday at ${time}`;
  return when.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

function RunHistory({ executions }: { executions: RoutineExecutionView[] }) {
  if (executions.length === 0) {
    return <div className="px-2 py-2 text-[12px] text-muted-foreground">No runs yet</div>;
  }
  return (
    <div aria-label="Run history" role="list">
      {executions.map((execution) => {
        const running = ["queued", "running", "waiting_approval"].includes(execution.status);
        return (
          <div
            aria-label={execution.kind === "test" ? "Manual run" : "Scheduled run"}
            className="flex min-h-8 items-center gap-2 py-1 text-[12px]"
            data-routine-execution-status={execution.status}
            key={execution.id}
            role="listitem"
          >
            <span className="min-w-0 flex-1 truncate">{executionTime(execution)}</span>
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
          </div>
        );
      })}
    </div>
  );
}

interface RoutineDraft {
  name: string;
  prompt: string;
  enabled: boolean;
  schedules: RoutineScheduleDraft[];
}

const newDraft = (): RoutineDraft => ({
  name: "",
  prompt: "",
  enabled: true,
  schedules: [],
});

const draftFromRoutine = (routine: RoutineView): RoutineDraft => ({
  name: routine.name,
  prompt: routine.prompt,
  enabled: routine.enabled,
  schedules: routineScheduleDrafts(routine),
});

const draftValid = (draft: RoutineDraft) =>
  draft.schedules.length > 0 &&
  draft.schedules.every((schedule) =>
    routineDraftValid({ name: draft.name, prompt: draft.prompt, schedule })
  );

export function RoutineEditor({
  botId,
  routineId,
  onDeleted,
}: {
  botId: string;
  routineId: string | null;
  onDeleted: () => void;
}) {
  const [routine, setRoutine] = useState<RoutineView | null>(null);
  const [draft, setDraft] = useState<RoutineDraft>(newDraft);
  const [executions, setExecutions] = useState<RoutineExecutionView[]>([]);
  const [expandedSchedule, setExpandedSchedule] = useState<number | null>(null);
  const [addTriggerOpen, setAddTriggerOpen] = useState(false);
  const [loading, setLoading] = useState(Boolean(routineId));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runError, setRunError] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const saveAgain = useRef(false);
  const routineRef = useRef<RoutineView | null>(null);
  const draftRef = useRef(draft);

  useEffect(() => {
    let cancelled = false;
    setLoading(Boolean(routineId));
    setRoutine(null);
    routineRef.current = null;
    setExecutions([]);
    setDirty(false);
    const initial = newDraft();
    setDraft(initial);
    draftRef.current = initial;
    setExpandedSchedule(null);
    setAddTriggerOpen(false);
    if (!routineId) return () => undefined;
    void Promise.all([api.routine(routineId), api.routineExecutions(routineId)]).then(
      ([loaded, history]) => {
        if (cancelled) return;
        const next = draftFromRoutine(loaded);
        routineRef.current = loaded;
        draftRef.current = next;
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
  }, [routineId]);

  const persist = useCallback(
    async (value: RoutineDraft) => {
      if (!draftValid(value)) return;
      if (saving.current) {
        saveAgain.current = true;
        return;
      }
      saving.current = true;
      setSaveState("saving");
      try {
        const trigger = routineTriggerValue(value.schedules);
        const presentation = routinePresentationValue(value.schedules);
        const current = routineRef.current;
        const saved = current
          ? await api.updateRoutine(current.id, {
              name: value.name.trim(),
              prompt: value.prompt.trim(),
              trigger,
              presentation,
              enabled: value.enabled,
              expectedRevision: current.revision,
            })
          : await api.createRoutine(botId, {
              name: value.name.trim(),
              prompt: value.prompt.trim(),
              trigger,
              presentation,
              enabled: value.enabled,
            });
        routineRef.current = saved;
        setRoutine(saved);
        if (draftRef.current === value) setDirty(false);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      } finally {
        saving.current = false;
        if (saveAgain.current) {
          saveAgain.current = false;
          void persist(draftRef.current);
        }
      }
    },
    [botId]
  );

  const queue = useCallback(
    (next: RoutineDraft, immediate = false) => {
      draftRef.current = next;
      setDraft(next);
      setDirty(true);
      setRunError(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (!draftValid(next)) {
        setSaveState("idle");
        return;
      }
      if (immediate) void persist(next);
      else timer.current = setTimeout(() => void persist(draftRef.current), 550);
    },
    [persist]
  );

  useEffect(() => {
    const current = routine?.id;
    if (!current) return;
    let stopped = false;
    const poll = async () => {
      try {
        const history = await api.routineExecutions(current);
        if (!stopped) setExecutions(history);
      } catch {
        // Keep the last durable history visible through transient refresh failures.
      }
    };
    const interval = window.setInterval(() => void poll(), 1_500);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [routine?.id]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const running = routine
    ? routineIsRunning({ ...routine, latestExecution: executions[0] ?? routine.latestExecution })
    : false;
  const valid = draftValid(draft);

  const toggleActive = (enabled: boolean) => {
    const next = { ...draft, enabled };
    if (!routineRef.current || dirty || saving.current) {
      queue(next, true);
      return;
    }
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    saving.current = true;
    setSaveState("saving");
    void api
      .setRoutineEnabled(routineRef.current, enabled)
      .then(
        (saved) => {
          routineRef.current = saved;
          setRoutine(saved);
          if (draftRef.current === next) setDirty(false);
          setSaveState("saved");
        },
        () => setSaveState("error")
      )
      .finally(() => {
        saving.current = false;
        if (saveAgain.current) {
          saveAgain.current = false;
          void persist(draftRef.current);
        }
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
      className="size-full overflow-y-auto px-[10px] pb-8 pt-[42px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-150"
      data-routine-editor=""
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Switch
            aria-label="Active"
            checked={draft.enabled}
            className="h-4 w-7 data-[state=checked]:bg-[#070707] [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3 dark:data-[state=checked]:bg-[#626262]"
            onCheckedChange={toggleActive}
          />
          <span className="text-[13px]">Active</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            className="h-7 rounded-[7px] px-2 text-[12px] font-normal"
            onClick={() => (routine ? setDeleteOpen(true) : onDeleted())}
            variant="secondary"
          >
            Delete
          </Button>
          <Button
            className="h-7 min-w-[60px] rounded-[7px] px-2 text-[12px] font-normal"
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
            {running ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin" /> Running…
              </>
            ) : (
              "Test run"
            )}
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
            <div aria-label="Triggers" role="list">
              {draft.schedules.map((schedule, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: schedule rows are ordered local drafts with no persisted identity.
                <ScheduleCard
                  expanded={expandedSchedule === index}
                  index={index}
                  key={`${index}-${schedule.preset}`}
                  onChange={(next) => {
                    const schedules = draft.schedules.map((item, itemIndex) =>
                      itemIndex === index ? next : item
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
                  value={schedule}
                />
              ))}
            </div>
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
                    const schedules = [...draft.schedules, schedule];
                    setExpandedSchedule(schedules.length - 1);
                    queue({ ...draft, schedules });
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
                if (!routine) return;
                void api.deleteRoutine(routine).then(onDeleted, () => setSaveState("error"));
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

export function RoutinesSummary({
  botId,
  onOpen,
}: {
  botId: string;
  onOpen: (routineId: string | null) => void;
}) {
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const refresh = useCallback(() => {
    void api.routines(botId).then(setRoutines, () => setRoutines([]));
  }, [botId]);
  useEffect(refresh, [refresh]);

  const sorted = useMemo(
    () =>
      routines?.slice().sort((left, right) => {
        if (left.nextRunAt && right.nextRunAt) return left.nextRunAt.localeCompare(right.nextRunAt);
        if (left.nextRunAt) return -1;
        if (right.nextRunAt) return 1;
        return left.createdAt.localeCompare(right.createdAt);
      }) ?? [],
    [routines]
  );

  if (routines === null) {
    return (
      <div className="grid flex-1 place-items-center">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="grid flex-1 place-items-center pb-[18vh]">
        <div className="text-center">
          <p className="mx-auto max-w-[220px] text-[13px] leading-[17px] text-muted-foreground">
            Routines are recurring tasks this Bot runs on a schedule.
          </p>
          <Button
            className="mt-3 h-8 rounded-[7px] border border-[#d9d9d9] bg-[#f0f0f0] px-3 text-[14px] font-normal text-foreground shadow-none dark:border-[#323232] dark:bg-[#1b1b1b] dark:text-[#fcfcfc]"
            onClick={() => onOpen(null)}
            variant="secondary"
          >
            Create Routine
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 min-h-0 flex-1 overflow-y-auto" data-routines-list="">
      <div className="flex items-center px-1">
        <h2 className="text-[13px] font-medium">Routines</h2>
        <Button
          aria-label="Create Routine"
          className="ml-auto size-7 rounded-full text-muted-foreground"
          onClick={() => onOpen(null)}
          size="icon-sm"
          variant="ghost"
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="mt-1 grid gap-1">
        {sorted.map((routine) => {
          const running = routineIsRunning(routine);
          return (
            <button
              className="group flex min-h-[42px] items-center gap-2 rounded-[9px] px-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/25"
              key={routine.id}
              onClick={() => onOpen(routine.id)}
              type="button"
            >
              <span className="grid size-3.5 shrink-0 place-items-center">
                {running ? (
                  <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                ) : routine.enabled ? (
                  <CalendarClock className="size-3.5 text-muted-foreground" />
                ) : (
                  <CirclePause className="size-3.5 text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{routine.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {running
                    ? "Running"
                    : routine.enabled
                      ? describeRoutineSchedule(
                          routineScheduleDrafts(routine)[0] ?? cloneDefaultSchedule()
                        )
                      : "Paused"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
