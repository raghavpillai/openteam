import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const componentSource = () =>
  readFile(
    new URL("../src/renderer/components/openteam/routine-panel.tsx", import.meta.url),
    "utf8"
  );

const summarySource = () =>
  readFile(
    new URL("../src/renderer/components/openteam/routine-summary.tsx", import.meta.url),
    "utf8"
  );

const rendererSource = (path: string) =>
  readFile(new URL(`../src/renderer/${path}`, import.meta.url), "utf8");

describe("Bot routine UI parity", () => {
  test("uses shadcn controls for every routine schedule picker", async () => {
    const source = await componentSource();

    expect(source).toContain('from "../ui/select"');
    expect(source).toContain('from "../ui/popover"');
    expect(source).toContain('from "../ui/dropdown-menu"');
    expect(source).toContain('data-routine-select=""');
    expect(source).toContain('data-routine-popover="multi-picker"');
    expect(source).toContain('data-routine-popover="add-trigger"');
    expect(source).toContain('data-routine-popover="add-schedule"');
    expect(source).toContain("DropdownMenuSub");
  });

  test("offers only time-based routine schedules", async () => {
    const source = await componentSource();

    for (const schedule of [
      'value: "hourly"',
      'value: "daily"',
      'value: "weekdays"',
      'value: "weekly"',
      'value: "monthly"',
      'value: "interval"',
      'value: "advanced"',
    ]) {
      expect(source).toContain(schedule);
    }
    for (const eventTrigger of ["Slack", "PagerDuty", "Webhook", "Sentry", "Microsoft Teams"]) {
      expect(source).not.toContain(eventTrigger);
    }
    expect(source).toContain('hasSchedules ? "Add another" : "Add trigger"');
    expect(source).toContain("On a schedule");
    expect(source).toContain('aria-label="Triggers"');
    expect(source).toContain('aria-label="Trigger fields"');
    expect(source).toContain("Remove trigger:");
    expect(source).toContain("m: [5, 10, 15, 20, 30, 45]");
    expect(source).not.toContain("m: [1, 2, 5");
  });

  test("preserves Bot's list ordering, empty state, and one-shot conflict rebase", async () => {
    const [source, summary] = await Promise.all([componentSource(), summarySource()]);

    expect(summary).toContain(
      'routines?.filter((routine) => routine.scheduleKind !== "event" && routine.enabled)'
    );
    expect(summary).toContain(
      'routines?.filter((routine) => routine.scheduleKind !== "event" && !routine.enabled)'
    );
    expect(summary).toContain("Routines are recurring tasks this Bot runs on a schedule.");
    expect(summary).toContain('data-routines-list=""');
    expect(summary).toContain("describeRoutineSchedules(schedules)");
    expect(source).toContain("error instanceof ClientError");
    expect(source).toContain("error.status !== 409");
    expect(source).toContain("const latest = await api.routine(current.id)");
    expect(source).toContain("await api.deleteRoutine(latest)");
    expect(source).not.toContain("AlertDialog");
    expect(source).not.toContain("deleteOpen");
  });

  test("keeps owner-scoped saves lossless and refresh work active-only", async () => {
    const [source, summary] = await Promise.all([componentSource(), summarySource()]);

    expect(source).toContain('ownerKind: "bot" | "group"');
    expect(source).toContain("api.createRoutine(context.ownerId, context.ownerKind");
    expect(source).toContain("const contextKey = `");
    expect(source).toContain('routineId ?? "new"');
    expect(source).toContain("saveContext.dirty && draftValid(saveContext.draft)");
    expect(source).toContain("void persist(saveContext, saveContext.draft)");
    expect(source).toContain("if (!active || !current) return");
    expect(source).toContain("if (document.hidden)");
    expect(summary).toContain("api.routines(ownerId, ownerKind)");
    expect(summary).toContain("routineSummaryProjectionEqual(current, next) ? current : next");
    expect(summary).toContain('contentVisibility: "auto"');
    expect(summary).toContain("if (!active) return");
  });

  test("keeps Active lifecycle separate while inactive routines remain testable", async () => {
    const source = await componentSource();
    const updateStart = source.indexOf("const update = (base: RoutineView)");
    const updateEnd = source.indexOf("let saved: RoutineView", updateStart);

    expect(source).toContain('running ? "w-[84px]" : "w-[62px]"');
    expect(source).toContain('{running ? "Running…" : "Test run"}');
    expect(source).not.toContain('<LoaderCircle className="size-3.5 animate-spin" /> Running…');
    expect(source).toContain("api.setRoutineEnabled(base, enabled)");
    expect(source).toContain(
      'disabled={!routine || !valid || dirty || running || saveState === "saving"}'
    );
    expect(source).toContain("routineScheduleValue(current)");
    expect(source).toContain("nextAdvancedTime(value.advancedTimes)");
    expect(source).toContain("aria-label={`Remove $" + "{timeLabel(time)}`}");
    expect(source).toContain("hideTransient={draft.schedules.length > 1}");
    expect(source).not.toContain("Available after the routine is saved");
    expect(source.slice(updateStart, updateEnd)).not.toContain("enabled:");
  });

  test("keeps the minimum-width routine toolbar inside the Bot panel geometry", async () => {
    const [routine, header] = await Promise.all([
      componentSource(),
      rendererSource("components/openteam/desktop-header.tsx"),
    ]);

    expect(routine).toContain('className="size-full overflow-y-auto px-3 pb-8 pt-[42px]');
    expect(routine).toContain('data-routine-actions=""');
    expect(routine).toContain('className="ml-auto flex shrink-0 items-center gap-2"');
    expect(header).toContain(
      'className="rounded-full text-foreground-tertiary hover:bg-transparent hover:text-foreground"'
    );
  });

  test("renders clickable lifecycle notices that open the exact routine editor", async () => {
    const [chatPane, app, inspector] = await Promise.all([
      rendererSource("components/openteam/chat-pane.tsx"),
      rendererSource("App.tsx"),
      rendererSource("components/openteam/inspector.tsx"),
    ]);

    expect(chatPane).toContain('data-channel-event="automation-changed"');
    expect(chatPane).toContain('data-routine-event-link=""');
    expect(chatPane).toContain("hover:bg-[#f1f1f1]");
    expect(chatPane).toContain("onOpenRoutine?.(routineEvent.automationId)");
    expect(app).toContain("setRoutineOpenTarget({ channelId, routineId, nonce: Date.now() })");
    expect(app).toContain('setInspectorMode("routine")');
    expect(app).toContain("setDetailsOpen(true)");
    expect(inspector).toContain("setSelectedRoutineId(routineOpenRequest.routineId)");
    expect(inspector).toContain("routineId={selectedRoutineId}");
  });
});
