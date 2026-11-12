import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineSchedule,
  parseRoutineSchedule,
  recoverRoutineCreation,
  routinePresentationValue,
  routineScheduleDrafts,
  routineScheduleUpdate,
  routineScheduleValue,
  routineScheduleValues,
  routineSchedulesError,
  routineTriggerValue,
  routineSummaryProjectionEqual,
  routineUpdateInput,
  routineDefinitionEqual,
  routineEditorResumeState,
  synchronizeRoutineEnabled,
  type RoutineView,
} from "../src/renderer/lib/routines";

const routineWith = (schedules: string[], extra: Partial<RoutineView> = {}): RoutineView =>
  ({
    id: "routine",
    revision: 1,
    name: "Audit",
    prompt: "Inspect",
    enabled: true,
    schedule: schedules[0] ?? "",
    schedules,
    trigger: routineTriggerValue(schedules.map(parseRoutineSchedule)),
    triggerPresentation: null,
    ...extra,
  }) as RoutineView;

const advanced = {
  ...DEFAULT_ROUTINE_SCHEDULE,
  preset: "advanced" as const,
  advancedEveryAmount: 45,
};

describe("routine editor preserves authored schedules", () => {
  test("validation errors refresh even when a disabled routine keeps its definition revision", () => {
    const routine = routineWith(["0 9 * * *"], { enabled: false });
    expect(
      routineSummaryProjectionEqual([routine], [{ ...routine, validationError: "Invalid trigger" }])
    ).toBe(false);
  });

  test("unrelated edits omit the trigger for every previously destructive round trip", () => {
    for (const schedule of [
      "0 9 * * 7",
      "0 9 1 * 1",
      "*/30 * 10 * 1",
      "*/60 * * * *",
      "CRON_TZ=Pacific/Honolulu 0 9 * * *",
    ]) {
      const routine = routineWith([schedule], {
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule },
            { type: "webhook", source: "alerts" },
          ],
        },
      });
      expect(routineScheduleUpdate(routine, routineScheduleDrafts(routine))).toEqual({});
    }
  });

  test("unrepresentable cron constraints remain custom rather than losing fields", () => {
    for (const schedule of ["0 9 1 * 1", "*/30 * 10 * 1", "*/60 * * * *"]) {
      const draft = parseRoutineSchedule(schedule);
      expect(draft.preset).toBe("custom");
      expect(routineScheduleValue(draft)).toBe(schedule);
    }
    expect(routineScheduleValue(parseRoutineSchedule("0 9 * * 7"))).toBe("0 9 * * 0");
  });

  test("ignores stale presentation and edits the current authored trigger", () => {
    const routine = routineWith(["0 17 * * *"], {
      triggerPresentation: routinePresentationValue([parseRoutineSchedule("0 8 * * *")]),
    });
    expect(routineScheduleDrafts(routine)[0]?.time).toBe("17:00");
    expect(routineScheduleUpdate(routine, routineScheduleDrafts(routine))).toEqual({});
  });

  test("a schedule edit retains mixed event listeners and explicit zones", () => {
    const routine = routineWith(["CRON_TZ=Pacific/Honolulu 0 9 * * *"], {
      trigger: {
        type: "group",
        listeners: [
          { type: "cron", schedule: "CRON_TZ=Pacific/Honolulu 0 9 * * *" },
          { type: "webhook", source: "alerts" },
        ],
      },
    });
    const draft = { ...routineScheduleDrafts(routine)[0]!, time: "10:00" };
    expect(routineScheduleUpdate(routine, [draft]).trigger).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "CRON_TZ=Pacific/Honolulu 0 10 * * *" },
        { type: "webhook", source: "alerts" },
      ],
    });
    expect(routineTriggerValue([parseRoutineSchedule("0 9 * * *")])).toEqual({
      type: "cron",
      schedule: "0 9 * * *",
    });
  });

  test("editing a sibling retains exact unchanged cron text and mixed pinned/floating zones", () => {
    const routine = routineWith(["*/45 * * * *", "CRON_TZ=UTC 0 9 * * *"]);
    const drafts = routineScheduleDrafts(routine);
    expect(
      routineScheduleUpdate(routine, [drafts[0]!, { ...drafts[1]!, time: "10:00" }]).trigger
    ).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "*/45 * * * *" },
        { type: "cron", schedule: "CRON_TZ=UTC 0 10 * * *" },
      ],
    });
  });

  test("existing valid Advanced presentation stays available without expanding ordinary minute steps", () => {
    const draft = { ...advanced, advancedEveryAmount: 30 };
    const routine = routineWith(["*/30 * * * *"], {
      triggerPresentation: routinePresentationValue([draft]),
    });
    expect(routineScheduleDrafts(routine)).toEqual([draft]);
    expect(routineSchedulesError(Array.from({ length: 8 }, () => draft))).toBeNull();
  });

  test("event-only routines can edit metadata and add a time without inventing a cron", () => {
    const routine = routineWith([], {
      scheduleKind: "event",
      trigger: { type: "webhook", source: "alerts" },
    });
    expect(routineScheduleDrafts(routine)).toEqual([]);
    expect(routineScheduleUpdate(routine, [])).toEqual({});
    expect(routineScheduleUpdate(routine, [parseRoutineSchedule("0 9 * * *")]).trigger).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "0 9 * * *" },
        { type: "webhook", source: "alerts" },
      ],
    });
  });

  test("correct existing time windows keep their schedule and stale presentation cannot pin a floating zone", () => {
    const every30 = {
      ...advanced,
      advancedEveryAmount: 30,
      advancedFromTime: "08:00",
      advancedToTime: "17:00",
    };
    expect(routineScheduleValues(every30)).toEqual(["*/30 8-17 * * *"]);
    expect(
      routineScheduleValues({ ...every30, advancedEveryAmount: 2, advancedEveryUnit: "h" })
    ).toEqual(["0 8-17/2 * * *"]);
    const routine = routineWith(["*/30 8-17 * * *"], {
      triggerPresentation: routinePresentationValue([{ ...every30, timeZone: "Pacific/Honolulu" }]),
    });
    expect(routineScheduleDrafts(routine)[0]?.timeZone).toBeUndefined();
    expect(routineScheduleUpdate(routine, routineScheduleDrafts(routine))).toEqual({});
  });

  test("mixed zones inside one old presentation card remain separate when a time is edited", () => {
    const routine = routineWith(["CRON_TZ=America/New_York 0 8 * * *", "CRON_TZ=UTC 0 10 * * *"], {
      triggerPresentation: routinePresentationValue([
        {
          ...advanced,
          advancedTimeMode: "at-times",
          advancedTimes: ["08:00", "10:00"],
        },
      ]),
    });
    const drafts = routineScheduleDrafts(routine);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.timeZone)).toEqual(["America/New_York", "UTC"]);
    expect(
      routineScheduleUpdate(routine, [{ ...drafts[0]!, time: "09:00" }, drafts[1]!]).trigger
    ).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "CRON_TZ=America/New_York 0 9 * * *" },
        { type: "cron", schedule: "CRON_TZ=UTC 0 10 * * *" },
      ],
    });
  });

  test("a delayed autosave cannot undo a newer Pause or Resume", async () => {
    for (const enabled of [false, true]) {
      let complete!: () => void;
      const firstSave = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const old = routineWith(["0 9 * * *"], { enabled: !enabled });
      const queued = {
        name: "Renamed",
        prompt: "New instruction",
        schedules: routineScheduleDrafts(old),
        enabled: !enabled,
      };
      const context = { draft: { enabled: !enabled }, routine: old };
      const savePending = async () => {
        await firstSave;
        return routineUpdateInput(context.routine, queued, context.draft.enabled);
      };
      const pending = savePending();
      // The dedicated toggle commits while the earlier content save is in flight.
      context.draft = { enabled };
      context.routine = { ...old, enabled, revision: 2 };
      complete();
      const input = await pending;
      expect(input).toEqual({ name: "Renamed", prompt: "New instruction", expectedRevision: 2 });
      expect({ ...context.routine, ...input }.enabled).toBe(enabled);
    }
  });

  test("uncertain creation applies the latest Pause even when recovery finishes later", async () => {
    const original = { name: "Original", prompt: "Old", enabled: true };
    const desired = { ...original, prompt: "Changed" };
    const routine = routineWith(["@every 1h"]);
    let resolve!: (value: RoutineView) => void;
    const response = new Promise<RoutineView>((done) => {
      resolve = done;
    });
    let latestEnabled = true;
    const result = recoverRoutineCreation(
      { clientId: "stable-create", input: original },
      desired,
      async () => response,
      () => undefined,
      async (saved) => ({
        ...saved,
        ...routineUpdateInput(
          saved,
          {
            name: desired.name,
            prompt: desired.prompt,
            schedules: routineScheduleDrafts(saved),
          },
          latestEnabled
        ),
      })
    );
    latestEnabled = false;
    resolve(routine);
    expect(await result).toMatchObject({ id: routine.id, enabled: false, prompt: "Changed" });
  });

  test("Pause during creation survives an invalid unsaved draft without saving invalid content", async () => {
    const original = { name: "Audit", prompt: "Inspect", enabled: true };
    const saved = routineWith(["@every 1h"]);
    let resolve!: (value: RoutineView) => void;
    const createResponse = new Promise<RoutineView>((done) => {
      resolve = done;
    });
    let localDraft = { ...original };
    let recovered: RoutineView | null = null;
    let updates = 0;
    const controls: boolean[] = [];
    const save = async () => {
      const routine = await recoverRoutineCreation(
        { clientId: "stable-create", input: original },
        original,
        async () => createResponse,
        (value) => {
          recovered = value;
        },
        async (value) => {
          updates++;
          return value;
        }
      );
      return synchronizeRoutineEnabled(
        routine,
        () => localDraft.enabled,
        async (value, enabled) => {
          controls.push(enabled);
          return { ...value, enabled, revision: value.revision + 1 };
        },
        async () => {
          throw new Error("Unexpected refresh");
        },
        () => false
      );
    };
    const pending = save();
    localDraft = { name: "", prompt: "", enabled: false };
    resolve(saved);
    expect(await pending).toMatchObject({
      id: saved.id,
      name: "Audit",
      prompt: "Inspect",
      enabled: false,
    });
    expect(recovered).toBe(saved);
    expect(updates).toBe(0);
    expect(controls).toEqual([false]);
  });

  test("Pause after creation retries a revision conflict without overwriting newer content", async () => {
    const saved = routineWith(["@every 1h"]);
    const latest = { ...saved, prompt: "Externally edited", revision: 7 };
    const calls: Array<[number, boolean]> = [];
    const conflict = new Error("Revision changed");
    const result = await synchronizeRoutineEnabled(
      saved,
      () => false,
      async (value, enabled) => {
        calls.push([value.revision, enabled]);
        if (value.revision === 1) throw conflict;
        return { ...value, enabled, revision: 8 };
      },
      async (id) => {
        expect(id).toBe(saved.id);
        return latest;
      },
      (error) => error === conflict
    );
    expect(result).toMatchObject({ prompt: "Externally edited", revision: 8, enabled: false });
    expect(calls).toEqual([
      [1, false],
      [7, false],
    ]);
  });

  test("a failed post-create Pause retains the recovered identity for retry", async () => {
    const original = { name: "Audit", prompt: "Inspect", enabled: true };
    const saved = routineWith(["@every 1h"]);
    let recovered: RoutineView | null = null;
    const routine = await recoverRoutineCreation(
      { clientId: "stable", input: original },
      original,
      async () => saved,
      (value) => {
        recovered = value;
      },
      async (value) => value
    );
    await expect(
      synchronizeRoutineEnabled(
        routine,
        () => false,
        async () => {
          throw new Error("Control response lost");
        },
        async () => {
          throw new Error("Unexpected refresh");
        },
        () => false
      )
    ).rejects.toThrow("Control response lost");
    expect(recovered).toBe(saved);
  });

  test("hide and re-show preserve an existing editor's pending save instead of pairing stale fields with a new revision", async () => {
    const old = routineWith(["0 9 * * *"]);
    const draft = { name: "Edited", prompt: "Latest instruction", enabled: true };
    const context = {
      routine: old,
      draft,
      dirty: true,
      saving: true,
      pending: null as typeof draft | null,
      saveState: "saving" as "saving" | "saved" | "error",
    };
    let finish!: (value: RoutineView) => void;
    const response = new Promise<RoutineView>((resolve) => {
      finish = resolve;
    });
    const save = response.then((saved) => {
      context.routine = saved;
      context.saving = false;
      context.dirty = false;
      context.saveState = "saved";
      return saved;
    });
    // A reopen happens before the request commits. The component uses this same
    // helper before resetting/fetching, retaining the actual outstanding draft.
    const resumed = routineEditorResumeState(context, old.id);
    expect(resumed?.draft).toBe(draft);
    expect(resumed?.dirty).toBe(true);
    expect(resumed?.saveState).toBe("saving");
    finish({ ...old, ...draft, revision: 2 });
    const saved = await save;
    expect(resumed?.draft.prompt).toBe(saved.prompt);
    expect(context.routine.revision).toBe(2);
    // Once clean, normal reopen fetches the latest server definition.
    expect(routineEditorResumeState(context, old.id)).toBeNull();
  });

  test("hidden failed saves retain their draft and error while clean created forms restore saved state", () => {
    const routine = routineWith(["0 9 * * *"]);
    const context = {
      routine,
      draft: { prompt: "Unsaved" },
      dirty: true,
      saving: false,
      pending: null,
      saveState: "error" as const,
    };
    expect(routineEditorResumeState(context, routine.id)).toMatchObject({
      draft: { prompt: "Unsaved" },
      dirty: true,
      saveState: "error",
    });
    expect(
      routineEditorResumeState({ ...context, dirty: false, saveState: "saved" }, null)?.saveState
    ).toBe("saved");
    expect(
      routineEditorResumeState({ ...context, dirty: false, saveState: "saved" }, routine.id)
    ).toBeNull();
  });

  test("recovered creation applies Pause before a server-rejected edited body", async () => {
    const original = { name: "Audit", prompt: "Inspect", enabled: true, schedule: "@every 1h" };
    const edited = { ...original, schedule: "* * * * *", enabled: false };
    const created = routineWith(["@every 1h"]);
    let server = created;
    let recoveredId: string | null = null;
    let retained: RoutineView | null = null;
    const order: string[] = [];
    await expect(
      recoverRoutineCreation(
        { clientId: "stable", input: original },
        edited,
        async () => created,
        async (receipt) => {
          recoveredId = receipt.id;
          const prepared = await synchronizeRoutineEnabled(
            receipt,
            () => false,
            async (base, enabled) => {
              order.push("pause");
              server = { ...server, enabled, revision: base.revision + 1 };
              return server;
            },
            async () => server,
            () => false
          );
          retained = prepared;
          return prepared;
        },
        async (base) => {
          order.push("content");
          expect(base.revision).toBe(2);
          expect(server.enabled).toBe(false);
          throw new Error("Schedule must be at least five minutes apart");
        }
      )
    ).rejects.toThrow("at least five minutes");
    expect(order).toEqual(["pause", "content"]);
    expect(recoveredId).toBe(created.id);
    expect(retained).toMatchObject({ id: created.id, enabled: false, revision: 2 });
    // Correcting the rejected body now uses the committed control revision.
    expect(
      routineUpdateInput(
        retained!,
        { name: "Audit", prompt: "Corrected", schedules: routineScheduleDrafts(created) },
        false
      )
    ).toMatchObject({ expectedRevision: 2 });
    expect(server).toMatchObject({ enabled: false, schedule: "@every 1h" });
  });

  test("control-only revision recovery cannot silently authorize a stale content overwrite", async () => {
    const original = { name: "Audit", prompt: "Inspect", enabled: true };
    const created = routineWith(["@every 1h"]);
    const external = { ...created, prompt: "Externally edited", revision: 7 };
    let server = external;
    let contentUpdates = 0;
    const conflict = new Error("Revision changed");
    await expect(
      recoverRoutineCreation(
        { clientId: "stable", input: original },
        { ...original, prompt: "Stale edit" },
        async () => created,
        async (receipt) => {
          const prepared = await synchronizeRoutineEnabled(
            receipt,
            () => false,
            async (base, enabled) => {
              if (base.revision === 1) throw conflict;
              server = { ...server, enabled, revision: 8 };
              return server;
            },
            async () => server,
            (error) => error === conflict
          );
          if (!routineDefinitionEqual(receipt, prepared)) throw conflict;
          return prepared;
        },
        async (base) => {
          contentUpdates++;
          return base;
        }
      )
    ).rejects.toBe(conflict);
    expect(contentUpdates).toBe(0);
    expect(server).toMatchObject({ enabled: false, prompt: "Externally edited" });
  });

  test("45-minute cadence fires every 45 minutes across two midnights", () => {
    const schedules = routineScheduleValues(advanced);
    expect(schedules).toHaveLength(4);
    const actual: number[] = [];
    // Independent minute-by-minute oracle interprets the generated minute/hour sets.
    for (let elapsed = 0; elapsed < 48 * 60; elapsed++) {
      const minute = elapsed % 60;
      const hour = Math.floor(elapsed / 60) % 24;
      if (
        schedules.some((schedule) => {
          const [minutes, hours] = schedule.split(" ");
          return (
            minutes!.split(",").map(Number).includes(minute) &&
            (hours === "*" || hours!.split(",").map(Number).includes(hour))
          );
        })
      )
        actual.push(elapsed);
    }
    expect(actual).toEqual(Array.from({ length: 64 }, (_, index) => index * 45));
  });

  test("one-day cadence respects selected days; unsupported multi-day filters explain the problem", () => {
    const monthDays = {
      ...advanced,
      advancedEveryUnit: "d" as const,
      advancedEveryAmount: 1,
      advancedDayMode: "month-days" as const,
      advancedMonthDays: [10, 20],
      advancedFromTime: "09:00",
    };
    expect(routineScheduleValues(monthDays)).toEqual(["0 9 10,20 * *"]);
    const weekdays = {
      ...monthDays,
      advancedDayMode: "weekdays" as const,
      advancedWeekDays: [1, 2, 3, 4, 5],
    };
    expect(routineScheduleValues(weekdays)).toEqual(["0 9 * * 1,2,3,4,5"]);
    expect(routineSchedulesError([weekdays])).toBeNull();
    expect(routineSchedulesError([{ ...weekdays, advancedEveryAmount: 2 }])).toContain(
      "cannot also restrict"
    );
  });

  test("validates expanded trigger counts, including preserved event listeners", () => {
    const atTimes = {
      ...advanced,
      advancedTimeMode: "at-times" as const,
      advancedTimes: ["08:00", "09:15", "10:30", "11:45", "13:00"],
    };
    expect(routineSchedulesError([atTimes, atTimes])).toContain("more than 8");
    const mixed = routineWith(["0 9 * * *"], {
      trigger: {
        type: "group",
        listeners: [
          { type: "cron", schedule: "0 9 * * *" },
          { type: "webhook", source: "alerts" },
        ],
      },
    });
    expect(routineSchedulesError([advanced, advanced], mixed)).toContain("more than 8");
  });

  test("summaries disclose selected months", () => {
    expect(describeRoutineSchedule({ ...advanced, advancedMonths: [1, 6] })).toContain(
      "in January, June"
    );
  });

  test("an uncertain create retries the original request then updates the recovered resource", async () => {
    const original = { name: "Original", prompt: "Old", enabled: true, schedule: "@every 1h" };
    const desired = { ...original, name: "Changed", prompt: "New" };
    const attempt = { clientId: "stable-create", input: original };
    const saved = routineWith(["@every 1h"]);
    const calls: unknown[] = [];
    let tries = 0;
    const create = async (input: unknown, id: string) => {
      calls.push([input, id]);
      if (++tries === 1) throw new Error("Response lost after commit");
      return saved;
    };
    let recovered: RoutineView | null = null;
    const remember = (value: RoutineView) => {
      recovered = value;
    };
    const update = async (value: RoutineView) => {
      expect(recovered).toBe(value);
      return { ...value, name: desired.name, prompt: desired.prompt, revision: 2 };
    };
    await expect(
      recoverRoutineCreation(attempt, original, create, remember, update)
    ).rejects.toThrow("Response lost");
    expect(await recoverRoutineCreation(attempt, desired, create, remember, update)).toMatchObject({
      id: saved.id,
      name: "Changed",
      prompt: "New",
      revision: 2,
    });
    expect(calls).toEqual([
      [original, "stable-create"],
      [original, "stable-create"],
    ]);
  });

  test("a failed post-recovery update still exposes the original ID for update-only retry", async () => {
    const original = { name: "Original", prompt: "Old", enabled: true };
    const saved = routineWith(["@every 1h"]);
    let recovered: RoutineView | null = null;
    await expect(
      recoverRoutineCreation(
        { clientId: "stable", input: original },
        { ...original, prompt: "New" },
        async () => saved,
        (value) => {
          recovered = value;
        },
        async () => {
          throw new Error("Update unavailable");
        }
      )
    ).rejects.toThrow("Update unavailable");
    expect(recovered).toBe(saved);
  });
});
