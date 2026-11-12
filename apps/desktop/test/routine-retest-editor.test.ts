import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  routinePresentationValue,
  routineScheduleDrafts,
  DEFAULT_ROUTINE_SCHEDULE,
  type RoutineView,
} from "../src/renderer/lib/routines";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const root = new URL("../../../", import.meta.url).pathname;
// Exercise the actual editor closures with inert host components, controlled effects,
// and deterministic API responses. This does not simulate browser layout or React DOM.
const key = "__routineEditorRetest";
const stubExports = [
  "RoutineDefinitionError",
  "Check",
  "ChevronDown",
  "ChevronRight",
  "CirclePlus",
  "Clock3",
  "LoaderCircle",
  "Pause",
  "X",
  "Button",
  "ButtonPrimitive",
  "DropdownMenu",
  "DropdownMenuContent",
  "DropdownMenuItem",
  "DropdownMenuSub",
  "DropdownMenuSubContent",
  "DropdownMenuSubTrigger",
  "DropdownMenuTrigger",
  "Input",
  "Label",
  "LoadingOrb",
  "Popover",
  "PopoverContent",
  "PopoverTrigger",
  "Select",
  "SelectContent",
  "SelectItem",
  "SelectTrigger",
  "SelectValue",
  "Switch",
  "Textarea",
];
let panel: any;
let dir: string;
beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [join(root, "apps/desktop/src/renderer/components/openteam/routine-panel.tsx")],
    target: "bun",
    plugins: [
      {
        name: "harness",
        setup(b) {
          b.onLoad({ filter: /routine-panel\.tsx$/ }, async (a) => ({
            contents:
              `import { timers as __timers } from 'retest:hooks';\n` +
              ((await Bun.file(a.path).text()) + "\nexport { ClientError as RetestClientError };")
                .replaceAll("window.setTimeout", "__timers.setTimeout")
                .replaceAll("window.clearTimeout", "__timers.clearTimeout")
                .replace(/(?<![.\w])setTimeout\(/g, "__timers.setTimeout(")
                .replace(/(?<![.\w])clearTimeout\(/g, "__timers.clearTimeout("),
            loader: "tsx",
          }));
          b.onResolve({ filter: /^(react(?:\/jsx(?:-dev)?-runtime)?|retest:hooks)$/ }, (a) => ({
            path: a.path,
            namespace: "retest",
          }));
          b.onResolve(
            {
              filter:
                /\/(?:ui\/[^/]+|routine-definition-error|window-visibility|client\/http|client\/openteam-api|lib\/cn)$/,
            },
            (a) => ({ path: a.path, namespace: "retest" })
          );
          b.onResolve({ filter: /^lucide-react$/ }, (a) => ({ path: a.path, namespace: "retest" }));
          b.onLoad({ filter: /.*/, namespace: "retest" }, (a) => ({
            contents: a.path.startsWith("react/jsx")
              ? `export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const jsxDEV=jsx; export const Fragment="Fragment";`
              : a.path === "react" || a.path === "retest:hooks"
                ? `const h=()=>globalThis.${key}; export const useState=(...a)=>h().useState(...a);export const useRef=(...a)=>h().useRef(...a);export const useEffect=(...a)=>h().useEffect(...a);export const useCallback=(...a)=>h().useCallback(...a);export const timers={setTimeout:(...a)=>h().setTimeout(...a),clearTimeout:(...a)=>h().clearTimeout(...a)};`
                : a.path.endsWith("openteam-api")
                  ? `export const api=new Proxy({}, {get:(_,key)=>(...a)=>globalThis.${key}.api[key](...a)});`
                  : a.path.endsWith("client/http")
                    ? `export class ClientError extends Error { constructor(message,code,status){super(message);this.code=code;this.status=status;} }`
                    : a.path.endsWith("window-visibility")
                      ? `export const isWindowVisible=()=>true;`
                      : a.path.endsWith("lib/cn")
                        ? `export const cn=(...a)=>a.filter(Boolean).join(' ');`
                        : stubExports.map((name) => `export const ${name}='${name}';`).join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  dir = await mkdtemp(join(tmpdir(), "routine-retest-"));
  await Bun.write(join(dir, "panel.mjs"), await built.outputs[0]!.text());
  panel = await import(join(dir, "panel.mjs"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Node = { type: string; props: Record<string, any> };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const baseRoutine = (): RoutineView => {
  const advanced = {
    ...DEFAULT_ROUTINE_SCHEDULE,
    preset: "advanced" as const,
    advancedEveryAmount: 30,
    advancedFromTime: "08:00",
    advancedToTime: "17:00",
  };
  const schedules = ["CRON_TZ=Pacific/Honolulu */30 8-17 * * *", "0 9 * * 7"];
  return {
    id: "routine",
    name: "Audit",
    prompt: "Original",
    enabled: true,
    revision: 1,
    schedule: schedules[0],
    schedules,
    triggerPresentation: routinePresentationValue([
      advanced,
      ...routineScheduleDrafts({
        schedules: [schedules[1]],
        schedule: schedules[1],
        triggerPresentation: null,
      } as RoutineView),
    ]),
    trigger: {
      type: "group",
      listeners: [
        { type: "cron", schedule: schedules[0] },
        { type: "webhook", source: "alerts" },
        { type: "cron", schedule: schedules[1] },
      ],
    },
  } as RoutineView;
};
class EditorHarness {
  slots: any[] = [];
  cursor = 0;
  effects: Array<() => void> = [];
  timers = new Map<number, { callback: () => void; delay: number }>();
  timerId = 0;
  tree!: Node;
  props = {
    active: true,
    ownerId: "bot",
    ownerKind: "bot",
    routineId: "routine" as string | null,
    onDeleted: () => {},
  };
  api: Record<string, (...args: any[]) => any>;
  server = baseRoutine();
  updates: any[] = [];
  constructor() {
    this.api = {
      routine: async () => this.server,
      routineExecutions: async () => [],
      updateRoutine: async (_id, input) => this.commitUpdate(input),
      setRoutineEnabled: async (base, enabled) =>
        this.commitUpdate({ expectedRevision: base.revision, enabled }),
    };
  }
  commitUpdate(input: any) {
    this.updates.push(input);
    if (input.expectedRevision !== this.server.revision)
      throw new panel.RetestClientError("Revision changed", "routine_revision_conflict", 409);
    this.server = { ...this.server, ...input, revision: this.server.revision + 1 };
    return this.server;
  }
  useState(initial: any) {
    const index = this.cursor++;
    if (!this.slots[index])
      this.slots[index] = { value: typeof initial === "function" ? initial() : initial };
    return [
      this.slots[index].value,
      (value: any) => {
        this.slots[index].value =
          typeof value === "function" ? value(this.slots[index].value) : value;
      },
    ];
  }
  useRef(initial: any) {
    const index = this.cursor++;
    return (this.slots[index] ??= { current: initial });
  }
  equal(a: any[], b: any[]) {
    return a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  useCallback(callback: any, deps: any[]) {
    const index = this.cursor++;
    if (!this.slots[index] || !this.equal(this.slots[index].deps, deps))
      this.slots[index] = { callback, deps };
    return this.slots[index].callback;
  }
  useEffect(effect: () => any, deps: any[]) {
    const index = this.cursor++;
    const previous = this.slots[index];
    if (previous && this.equal(previous.deps, deps)) return;
    this.slots[index] = { deps, cleanup: previous?.cleanup };
    this.effects.push(() => {
      this.slots[index].cleanup?.();
      this.slots[index].cleanup = effect();
    });
  }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.timerId;
    this.timers.set(id, { callback, delay });
    return id;
  }
  clearTimeout(id: number) {
    this.timers.delete(id);
  }
  render() {
    (globalThis as any)[key] = this;
    this.cursor = 0;
    this.tree = panel.RoutineEditor(this.props);
    const effects = this.effects.splice(0);
    effects.forEach((run) => run());
  }
  async flush() {
    for (let i = 0; i < 16; i++) {
      await Promise.resolve();
      this.render();
    }
  }
  async start() {
    this.render();
    await this.flush();
  }
  find(predicate: (node: Node) => boolean, current: any = this.tree): Node | undefined {
    if (Array.isArray(current))
      return current.map((child) => this.find(predicate, child)).find(Boolean);
    if (!current || typeof current !== "object") return;
    if (predicate(current)) return current;
    return current.props?.children === undefined
      ? undefined
      : this.find(predicate, current.props.children);
  }
  input(id: string, value: string) {
    this.find((n) => n.props?.id === id)!.props.onChange({ target: { value } });
    this.render();
  }
  toggle(enabled: boolean) {
    this.find((n) => n.props?.["aria-label"] === "Active")!.props.onCheckedChange(enabled);
    this.render();
  }
  addSchedule() {
    this.find(
      (n) => typeof n.type === "function" && n.type.name === "AddScheduleMenu"
    )!.props.onAdd({ ...DEFAULT_ROUTINE_SCHEDULE });
    this.render();
  }
  debounce() {
    for (const [id, timer] of this.timers)
      if (timer.delay === 550) {
        this.timers.delete(id);
        timer.callback();
      }
    this.render();
  }
  async visibility(active: boolean) {
    this.props.active = active;
    this.render();
    await this.flush();
  }
  get prompt() {
    return this.find((n) => n.props?.id === "routine-instruction")!.props.value;
  }
  get enabled() {
    return this.find((n) => n.props?.["aria-label"] === "Active")!.props.checked;
  }
}

describe("routine editor component deferred-response retest", () => {
  test("hide/reopen retains authored mixed listeners and Advanced presentation through queued saves", async () => {
    const h = new EditorHarness();
    await h.start();
    const originalTrigger = structuredClone(h.server.trigger);
    const originalPresentation = structuredClone(h.server.triggerPresentation);
    const delayed = deferred<RoutineView>();
    h.api.updateRoutine = async (_id, input) => {
      const saved = h.commitUpdate(input);
      return h.updates.length === 1 ? delayed.promise : saved;
    };
    h.input("routine-instruction", "First edit");
    h.debounce();
    const firstSaved = h.server;
    h.input("routine-instruction", "Latest edit");
    h.debounce();
    await h.visibility(false);
    await h.visibility(true);
    expect(h.prompt).toBe("Latest edit");
    delayed.resolve(firstSaved);
    await h.flush();
    expect(h.server.prompt).toBe("Latest edit");
    expect(h.server.trigger).toEqual(originalTrigger);
    expect(h.server.triggerPresentation).toEqual(originalPresentation);
    expect(h.updates.map((x) => x.expectedRevision)).toEqual([1, 2]);
    expect(h.updates.every((x) => !("trigger" in x) && !("presentation" in x))).toBe(true);
  });

  test("uncertain creation reuses the original nonce and request before applying the newest paused draft", async () => {
    const h = new EditorHarness();
    h.props.routineId = null;
    const attempts: Array<{ input: any; nonce: string }> = [];
    h.api.createRoutine = async (_owner, _kind, input, nonce) => {
      attempts.push({ input: structuredClone(input), nonce });
      if (attempts.length === 1) {
        const schedules = [input.trigger.schedule];
        h.server = {
          ...h.server,
          id: "created",
          name: input.name,
          prompt: input.prompt,
          enabled: input.enabled,
          revision: 1,
          trigger: input.trigger,
          triggerPresentation: input.presentation,
          schedules,
          schedule: schedules[0],
        };
        throw new Error("Response lost after commit");
      }
      return h.server;
    };
    await h.start();
    h.input("routine-name", "Original name");
    h.input("routine-instruction", "Original body");
    h.addSchedule();
    h.debounce();
    await h.flush();
    expect(attempts).toHaveLength(1);
    h.input("routine-name", "Newest name");
    h.input("routine-instruction", "Newest body");
    h.toggle(false);
    await h.flush();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(h.server).toMatchObject({
      id: "created",
      name: "Newest name",
      prompt: "Newest body",
      enabled: false,
    });
    expect(h.prompt).toBe("Newest body");
    expect(h.enabled).toBe(false);
  });

  test("creation recovery pauses the resource while the latest unsaved body is invalid", async () => {
    const h = new EditorHarness();
    h.props.routineId = null;
    const delayed = deferred<RoutineView>();
    h.api.createRoutine = async (_owner, _kind, input) => {
      const schedules = [input.trigger.schedule];
      h.server = {
        ...h.server,
        id: "created",
        name: input.name,
        prompt: input.prompt,
        enabled: input.enabled,
        revision: 1,
        trigger: input.trigger,
        triggerPresentation: input.presentation,
        schedules,
        schedule: schedules[0],
      };
      return delayed.promise;
    };
    await h.start();
    h.input("routine-name", "Created");
    h.input("routine-instruction", "Valid body");
    h.addSchedule();
    h.debounce();
    h.toggle(false);
    h.input("routine-instruction", "");
    delayed.resolve(h.server);
    await h.flush();
    expect(h.server).toMatchObject({ id: "created", prompt: "Valid body", enabled: false });
    expect(h.prompt).toBe("");
    expect(h.enabled).toBe(false);
    await h.visibility(false);
    await h.visibility(true);
    expect(h.prompt).toBe("");
    expect(h.enabled).toBe(false);
  });

  test("Resume during a delayed post-create Pause retains the newest control and revision", async () => {
    const h = new EditorHarness();
    h.props.routineId = null;
    const createResponse = deferred<RoutineView>();
    const pauseResponse = deferred<RoutineView>();
    h.api.createRoutine = async (_owner, _kind, input) => {
      const schedules = [input.trigger.schedule];
      h.server = {
        ...h.server,
        id: "created",
        name: input.name,
        prompt: input.prompt,
        enabled: input.enabled,
        revision: 1,
        trigger: input.trigger,
        triggerPresentation: input.presentation,
        schedules,
        schedule: schedules[0],
      };
      return createResponse.promise;
    };
    let paused!: RoutineView;
    h.api.setRoutineEnabled = async (base, enabled) => {
      const saved = h.commitUpdate({ expectedRevision: base.revision, enabled });
      if (!enabled) {
        paused = saved;
        return pauseResponse.promise;
      }
      return saved;
    };
    await h.start();
    h.input("routine-name", "Created");
    h.input("routine-instruction", "Valid body");
    h.addSchedule();
    h.debounce();
    h.toggle(false);
    createResponse.resolve(h.server);
    await h.flush();
    expect(h.server.enabled).toBe(false);
    h.toggle(true);
    await h.flush();
    expect(h.server.enabled).toBe(true);
    pauseResponse.resolve(paused);
    await h.flush();
    expect(h.enabled).toBe(true);
    h.input("routine-instruction", "Latest body");
    h.debounce();
    await h.flush();
    expect(h.server).toMatchObject({ id: "created", enabled: true, prompt: "Latest body" });
  });

  test("content response arriving after Pause preserves the latest revision for a subsequent edit", async () => {
    const h = new EditorHarness();
    await h.start();
    const delayed = deferred<RoutineView>();
    h.api.updateRoutine = async (_id, input) => {
      const saved = h.commitUpdate(input);
      return h.updates.filter((x) => "prompt" in x).length === 1 ? delayed.promise : saved;
    };
    h.input("routine-instruction", "First edit");
    h.debounce();
    const firstSaved = h.server;
    h.toggle(false);
    await h.flush();
    expect(h.server.enabled).toBe(false);
    delayed.resolve(firstSaved);
    await h.flush();
    expect(h.enabled).toBe(false);
    h.input("routine-instruction", "Latest edit");
    h.debounce();
    await h.flush();
    expect(h.server.prompt).toBe("Latest edit");
    expect(h.server.enabled).toBe(false);
  });

  test("a poll captured before Pause cannot restore an older active revision", async () => {
    const h = new EditorHarness();
    await h.start();
    const old = h.server;
    const delayed = deferred<RoutineView>();
    h.api.routine = async () => delayed.promise;
    const poll = [...h.timers].find(([, timer]) => timer.delay === 1500)!;
    h.timers.delete(poll[0]);
    poll[1].callback();
    await h.flush();
    h.toggle(false);
    await h.flush();
    expect(h.server.enabled).toBe(false);
    delayed.resolve(old);
    await h.flush();
    expect(h.enabled).toBe(false);
    h.input("routine-name", "After poll");
    h.debounce();
    await h.flush();
    expect(h.server).toMatchObject({ name: "After poll", enabled: false });
  });

  test("content edited during a delayed Pause response saves after its control revision", async () => {
    const h = new EditorHarness();
    await h.start();
    const delayed = deferred<RoutineView>();
    h.api.setRoutineEnabled = async (base, enabled) => {
      const saved = h.commitUpdate({ expectedRevision: base.revision, enabled });
      return delayed.promise;
    };
    h.toggle(false);
    const paused = h.server;
    h.input("routine-instruction", "Edited while pausing");
    h.debounce();
    await h.flush();
    delayed.resolve(paused);
    await h.flush();
    expect(h.server).toMatchObject({ enabled: false, prompt: "Edited while pausing" });
  });

  test("control conflict recovery cannot authorize restoring stale instructions on the next unrelated edit", async () => {
    const h = new EditorHarness();
    await h.start();
    h.server = { ...h.server, prompt: "Externally edited", revision: 7 };
    h.toggle(false);
    await h.flush();
    expect(h.server.prompt).toBe("Externally edited");
    expect(h.server.enabled).toBe(false);
    h.input("routine-name", "New name");
    h.debounce();
    await h.flush();
    expect(h.server.prompt).toBe("Externally edited");
    expect(h.server.name).toBe("New name");
  });

  test("an explicit reload resolves a conflict while hide/reopen preserves unsaved input", async () => {
    const h = new EditorHarness();
    await h.start();
    h.server = { ...h.server, prompt: "Externally edited", revision: 7 };
    h.input("routine-instruction", "Local stale edit");
    h.debounce();
    await h.flush();
    expect(h.server.prompt).toBe("Externally edited");
    await h.visibility(false);
    await h.visibility(true);
    expect(h.prompt).toBe("Local stale edit");
    h.find((n) => n.props?.children === "Reload latest")!.props.onClick();
    await h.flush();
    expect(h.prompt).toBe("Externally edited");
    h.input("routine-name", "Recovered name");
    h.debounce();
    await h.flush();
    expect(h.server).toMatchObject({ name: "Recovered name", prompt: "Externally edited" });
  });

  test("control conflict adopts external trigger changes before a clean name edit", async () => {
    const h = new EditorHarness();
    await h.start();
    const externalTrigger = {
      type: "group",
      listeners: [
        { type: "cron", schedule: "CRON_TZ=Asia/Kathmandu 0 17 * * 7" },
        { type: "webhook", source: "new-alerts" },
      ],
    };
    h.server = {
      ...h.server,
      revision: 7,
      trigger: externalTrigger,
      schedules: ["CRON_TZ=Asia/Kathmandu 0 17 * * 7"],
      schedule: "CRON_TZ=Asia/Kathmandu 0 17 * * 7",
      triggerPresentation: null,
    } as RoutineView;
    h.toggle(false);
    await h.flush();
    h.input("routine-name", "New name");
    h.debounce();
    await h.flush();
    expect(h.server.trigger).toEqual(externalTrigger);
    expect(h.updates.at(-1)).not.toHaveProperty("trigger");
    expect(h.updates.at(-1)).not.toHaveProperty("presentation");
  });

  test("control conflict retains a dirty draft but blocks stale saves until explicit reload", async () => {
    const h = new EditorHarness();
    await h.start();
    h.input("routine-instruction", "Unsaved local edit");
    h.server = { ...h.server, revision: 7, prompt: "External instructions" };
    h.toggle(false);
    await h.flush();
    h.debounce();
    await h.flush();
    expect(h.prompt).toBe("Unsaved local edit");
    expect(h.server).toMatchObject({ enabled: false, prompt: "External instructions" });
    h.input("routine-name", "Still local");
    h.debounce();
    await h.flush();
    expect(h.server.name).toBe("Audit");
    expect(h.server.prompt).toBe("External instructions");
    h.find((n) => n.props?.children === "Reload latest")!.props.onClick();
    await h.flush();
    expect(h.prompt).toBe("External instructions");
    expect(h.enabled).toBe(false);
    h.input("routine-name", "Safely edited");
    h.debounce();
    await h.flush();
    expect(h.server).toMatchObject({
      name: "Safely edited",
      prompt: "External instructions",
      enabled: false,
    });
  });
});
