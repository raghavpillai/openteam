import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const componentSource = () =>
  readFile(
    new URL("../src/renderer/components/openbot/routine-panel.tsx", import.meta.url),
    "utf8"
  );

const rendererSource = (path: string) =>
  readFile(new URL(`../src/renderer/${path}`, import.meta.url), "utf8");

describe("Grok routine UI parity", () => {
  test("uses the shadcn Select and Popover primitives for routine controls", async () => {
    const source = await componentSource();

    expect(source).toContain('from "../ui/select"');
    expect(source).toContain('from "../ui/popover"');
    expect(source).toContain('data-routine-select=""');
    expect(source).toContain('data-routine-popover="multi-picker"');
    expect(source).toContain('data-routine-popover="event-picker"');
    expect(source).toContain('data-routine-popover="add-trigger"');
  });

  test("renders Grok's connector ordering with matching brand glyphs", async () => {
    const source = await componentSource();

    expect(source).toContain("routineTriggerKinds.slice(1).map");
    for (const icon of [
      "SlackIcon",
      "GitHubIcon",
      "TeamsIcon",
      "LinearIcon",
      "SentryIcon",
      "PagerDutyIcon",
    ]) {
      expect(source).toContain(`function ${icon}`);
    }
    expect(source).toContain('fill="#5E6AD2"');
    expect(source).toContain('fill="#6E47AE"');
    expect(source).toContain('fill="#06AC38"');
  });

  test("keeps Grok's complete saved-webhook credential layout", async () => {
    const source = await componentSource();

    expect(source).toContain("<span className={labelClass}>POST to</span>");
    expect(source).toContain("<span className={labelClass}>key</span>");
    expect(source).toContain("<span className={labelClass}>header</span>");
    expect(source).toContain('aria-label="Webhook URL"');
    expect(source).toContain('aria-label="Webhook key"');
    expect(source).toContain('aria-label="Webhook header"');
  });

  test("preserves Grok's list ordering, empty state, and one-shot conflict rebase", async () => {
    const source = await componentSource();

    expect(source).toContain("routines?.filter((routine) => routine.enabled)");
    expect(source).toContain("routines?.filter((routine) => !routine.enabled)");
    expect(source).toContain("Routines are recurring tasks this Bot runs on a schedule.");
    expect(source).toContain('data-routines-list=""');
    expect(source).toContain("error instanceof ClientError");
    expect(source).toContain("error.status !== 409");
    expect(source).toContain("const latest = await api.routine(current.id)");
    expect(source).toContain("await api.deleteRoutine(latest)");
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
    expect(source.slice(updateStart, updateEnd)).not.toContain("enabled:");
  });

  test("keeps the minimum-width routine toolbar inside the Grok panel geometry", async () => {
    const [routine, header] = await Promise.all([
      componentSource(),
      rendererSource("components/openbot/desktop-header.tsx"),
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
      rendererSource("components/openbot/chat-pane.tsx"),
      rendererSource("App.tsx"),
      rendererSource("components/openbot/inspector.tsx"),
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
