import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const runtime = readFileSync(new URL("./message-renderer.js", import.meta.url), "utf8");

function reporter() {
  const bounds = { height: 21, width: 0 };
  const reports: { height: number; width: number; lease: string }[] = [];
  const context = createContext({
    marked: { use() {} },
    document: { getElementById: () => ({ getBoundingClientRect: () => bounds }) },
    ResizeObserver: class { observe() {} },
    window: { webkit: { messageHandlers: { height: { postMessage: (value: typeof reports[number]) => reports.push(value) } } } },
  });
  runInContext(runtime, context);
  runInContext('activeLease = "current-document"', context);
  return { bounds, reports, context, report: () => runInContext("reportHeight()", context) };
}

test("reports the width associated with the measured height and lease", () => {
  const { bounds, reports, report } = reporter();
  bounds.height = 21_437.2;
  report();
  expect(reports).toEqual([{ height: 21_438, width: 0, lease: "current-document", ready: false }]);
  bounds.height = 890;
  bounds.width = 298;
  report();
  expect(reports[1]).toEqual({ height: 890, width: 298, lease: "current-document", ready: false });
});

test("reports a width-only change but never duplicate unchanged geometry", () => {
  const { bounds, reports, report } = reporter();
  report();
  report();
  bounds.width = 298;
  report();
  report();
  expect(reports).toEqual([
    { height: 21, width: 0, lease: "current-document", ready: false },
    { height: 21, width: 298, lease: "current-document", ready: false },
  ]);
});

test("signals readiness even when fonts settle without changing height", () => {
  const { context, reports, report } = reporter();
  report();
  runInContext("layoutReady = true", context);
  report();
  expect(reports).toHaveLength(2);
  expect(reports[1]).toMatchObject({ ready: true });
});

test("waits for fonts and discards superseded document completion", async () => {
  const { context, reports, bounds } = reporter();
  let finishFonts!: () => void;
  const fonts = new Promise<void>((resolve) => { finishFonts = resolve; });
  const root = {
    getBoundingClientRect: () => bounds, innerHTML: "",
    querySelectorAll: () => [], querySelector: () => null,
  };
  Object.assign(context, {
    DOMPurify: { sanitize: (value: string) => value },
    document: { getElementById: () => root, fonts: { ready: fonts }, body: { style: { setProperty() {} } } },
    marked: { parse: (source: string) => source },
  });
  const first = runInContext("window.renderMessage('old',false,17,{},'old-lease')", context);
  const second = runInContext("window.renderMessage('new',false,17,{},'new-lease')", context);
  expect(reports).toHaveLength(0);
  bounds.width = 298;
  bounds.height = 160;
  finishFonts();
  await Promise.all([first, second]);
  expect(reports).toEqual([{ height: 160, width: 298, lease: "new-lease", ready: true }]);
});

function classes(initial: string[] = []) {
  const set = new Set(initial);
  return {
    set,
    add: (name: string) => void set.add(name),
    remove: (name: string) => void set.delete(name),
    contains: (name: string) => set.has(name),
    toggle: (name: string, on: boolean) => void (on ? set.add(name) : set.delete(name)),
  };
}

test("keeps short columns on one line and lets prose columns wrap between words", () => {
  const { context } = reporter();
  const created: { className: string; children: unknown[] }[] = [];
  Object.assign(context.document, {
    createElement: () => {
      const node = { className: "", children: [] as unknown[], classList: classes(),
        append(child: unknown) { this.children.push(child); }, addEventListener() {} };
      created.push(node);
      return node;
    },
  });
  const rows = [
    ["Plan", "Price", "Best for"],
    ["Basic", "$9/mo", "Personal projects and trying things out"],
    ["Business", "$99/mo", "Larger orgs with SSO"],
  ].map((row) => ({ cells: row.map((text) => ({ textContent: text, classList: classes() })) }));
  let wrapper: unknown;
  const table = { rows, replaceWith: (node: unknown) => { wrapper = node; } };
  context.table = table;
  runInContext("layoutTable(table)", context);

  expect(created).toHaveLength(1);
  expect(wrapper).toBe(created[0]);
  expect(created[0]).toMatchObject({ className: "table-scroll", children: [table] });
  const columnClasses = (column: number) => rows.map((row) => [...row.cells[column]!.classList.set]);
  expect(columnClasses(0)).toEqual([["cell-nowrap"], ["cell-nowrap"], ["cell-nowrap"]]);
  expect(columnClasses(1)).toEqual([["cell-nowrap"], ["cell-nowrap"], ["cell-nowrap"]]);
  expect(columnClasses(2)).toEqual([["cell-wrap"], ["cell-wrap"], ["cell-wrap"]]);
});

test("narrows prose columns only when that keeps a table from scrolling", () => {
  const { context } = reporter();
  const strip = (normal: number, compact: number) => {
    const classList = classes();
    return {
      classList, clientWidth: 298, scrollLeft: 0,
      get scrollWidth() { return classList.contains("compact") ? compact : normal; },
    };
  };
  const fits = strip(280, 280);
  const fitsWhenNarrowed = strip(330, 290);
  const scrollsAnyway = strip(520, 410);
  for (const scroll of [fits, fitsWhenNarrowed, scrollsAnyway]) {
    context.scroll = scroll;
    runInContext("fitTable(scroll)", context);
  }

  expect([...fits.classList.set]).toEqual([]);
  expect([...fitsWhenNarrowed.classList.set]).toEqual(["compact"]);
  // A table that scrolls anyway keeps readable prose and fades its hidden edge.
  expect([...scrollsAnyway.classList.set]).toEqual(["more-right"]);
});
