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
  return { bounds, reports, report: () => runInContext("reportHeight()", context) };
}

test("reports the width associated with the measured height and lease", () => {
  const { bounds, reports, report } = reporter();
  bounds.height = 21_437.2;
  report();
  expect(reports).toEqual([{ height: 21_438, width: 0, lease: "current-document" }]);
  bounds.height = 890;
  bounds.width = 298;
  report();
  expect(reports[1]).toEqual({ height: 890, width: 298, lease: "current-document" });
});

test("reports a valid width even when adopting it does not change height", () => {
  const { bounds, reports, report } = reporter();
  report();
  bounds.width = 298;
  report();
  expect(reports).toEqual([
    { height: 21, width: 0, lease: "current-document" },
    { height: 21, width: 298, lease: "current-document" },
  ]);
});

test("does not send duplicate unchanged geometry", () => {
  const { bounds, reports, report } = reporter();
  bounds.width = 298;
  report();
  report();
  expect(reports).toHaveLength(1);
});
