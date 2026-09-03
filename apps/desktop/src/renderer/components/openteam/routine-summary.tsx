import { CalendarClock, CirclePause, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../client/openteam-api";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineSchedule,
  describeRoutineSchedules,
  type RoutineScheduleDraft,
  type RoutineView,
  routineIsRunning,
  routineScheduleDrafts,
  routineSummaryProjectionEqual,
} from "../../lib/routines";
import { Button } from "../ui/button";

const cloneDefaultSchedule = (): RoutineScheduleDraft => ({
  ...DEFAULT_ROUTINE_SCHEDULE,
  advancedMonths: [...DEFAULT_ROUTINE_SCHEDULE.advancedMonths],
  advancedWeekDays: [...DEFAULT_ROUTINE_SCHEDULE.advancedWeekDays],
  advancedMonthDays: [...DEFAULT_ROUTINE_SCHEDULE.advancedMonthDays],
  advancedTimes: [...DEFAULT_ROUTINE_SCHEDULE.advancedTimes],
});

export function RoutinesSummary({
  active,
  ownerId,
  ownerKind,
  onOpen,
}: {
  active: boolean;
  ownerId: string;
  ownerKind: "bot" | "group";
  onOpen: (routineId: string | null) => void;
}) {
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  useEffect(() => {
    setRoutines(null);
    if (!active) return;
    let stopped = false;
    let inFlight = false;
    let rerun = false;
    const refresh = async () => {
      if (stopped) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      try {
        const next = await api.routines(ownerId, ownerKind);
        if (!stopped) {
          setRoutines((current) => (routineSummaryProjectionEqual(current, next) ? current : next));
        }
      } catch {
        if (!stopped) setRoutines([]);
      } finally {
        inFlight = false;
        if (!stopped && rerun) {
          rerun = false;
          void refresh();
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, ownerId, ownerKind]);

  const sorted = useMemo(
    () => [
      ...(routines?.filter((routine) => routine.scheduleKind !== "event" && routine.enabled) ?? []),
      ...(routines?.filter((routine) => routine.scheduleKind !== "event" && !routine.enabled) ??
        []),
    ],
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
      <div className="flex flex-1 items-center justify-center px-4 py-4">
        <div className="grid max-w-64 gap-3 text-center">
          <p className="text-[13px] leading-[17px] text-muted-foreground">
            Routines are recurring tasks this Bot runs on a schedule.
          </p>
          <Button
            className="mx-auto h-8 rounded-[7px] border border-[#d9d9d9] bg-[#f0f0f0] px-3 text-[14px] font-normal text-foreground shadow-none dark:border-[#323232] dark:bg-[#1b1b1b] dark:text-[#fcfcfc]"
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
      <ul aria-label="Routines" className="mt-1 grid gap-1">
        {sorted.map((routine) => {
          const running = routineIsRunning(routine);
          const schedules = routineScheduleDrafts(routine);
          const detail = routine.enabled
            ? schedules.length > 0
              ? describeRoutineSchedules(schedules)
              : describeRoutineSchedule(cloneDefaultSchedule())
            : "Paused";
          return (
            <li key={routine.id}>
              <button
                className="group flex min-h-[42px] w-full items-center gap-2 rounded-[9px] px-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/25"
                onClick={() => onOpen(routine.id)}
                style={{ containIntrinsicSize: "42px", contentVisibility: "auto" }}
                type="button"
              >
                <span className="grid size-3.5 shrink-0 place-items-center">
                  {running ? (
                    <LoaderCircle className="size-3.5 animate-spin text-[#0c64c1] dark:text-[#4aa8ff]" />
                  ) : routine.enabled ? (
                    <CalendarClock className="size-3.5 text-[#00673a] dark:text-[#53b782]" />
                  ) : (
                    <CirclePause className="size-3.5 text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{routine.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
