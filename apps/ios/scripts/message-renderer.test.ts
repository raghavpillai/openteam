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

test("reports a valid width even when adopting it does not change height", () => {
  const { bounds, reports, report } = reporter();
  report();
  bounds.width = 298;
  report();
  expect(reports).toEqual([
    { height: 21, width: 0, lease: "current-document", ready: false },
    { height: 21, width: 298, lease: "current-document", ready: false },
  ]);
});

test("does not send duplicate unchanged geometry", () => {
  const { bounds, reports, report } = reporter();
  bounds.width = 298;
  report();
  report();
  expect(reports).toHaveLength(1);
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
