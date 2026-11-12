import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  parseRoutineSchedule,
  recoverRoutineCreation,
  routinePresentationValue,
  routineScheduleDrafts,
  routineScheduleUpdate,
  routineScheduleValue,
  routineScheduleValues,
  routineTriggerValue,
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
});

describe("routine schedule serialization", () => {
  test("round-trips every visible preset", () => {
    expect(routineScheduleValue(parseRoutineSchedule("0 * * * *"))).toBe("0 * * * *");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 * * *"))).toBe("15 9 * * *");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 * * 1-5"))).toBe("15 9 * * 1-5");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 * * 2"))).toBe("15 9 * * 2");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 20 * *"))).toBe("15 9 20 * *");
    expect(routineScheduleValue(parseRoutineSchedule("@every 30m"))).toBe("@every 30m");
  });

  test("builds one cron listener or an OpenTeam-style trigger group", () => {
    const weekdays = parseRoutineSchedule("0 9 * * 1-5");
    const daily = parseRoutineSchedule("0 17 * * *");
    expect(routineTriggerValue([weekdays])).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
    expect(routineTriggerValue([weekdays, daily])).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "0 9 * * 1-5" },
        { type: "cron", schedule: "0 17 * * *" },
      ],
    });
    expect(
      routineTriggerValue([weekdays, parseRoutineSchedule("@every 5m")], "America/New_York")
    ).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "CRON_TZ=America/New_York 0 9 * * 1-5" },
        { type: "cron", schedule: "@every 5m" },
      ],
    });
  });

  test("preserves exact Advanced times without creating a cron cross-product", () => {
    const advanced = {
      ...DEFAULT_ROUTINE_SCHEDULE,
      preset: "advanced" as const,
      advancedTimeMode: "at-times" as const,
      advancedTimes: ["08:00", "09:15"],
    };
    expect(routineScheduleValues(advanced)).toEqual(["0 8 * * *", "15 9 * * *"]);
    expect(routineTriggerValue([advanced])).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "0 8 * * *" },
        { type: "cron", schedule: "15 9 * * *" },
      ],
    });
  });
});
