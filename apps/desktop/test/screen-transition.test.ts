import { afterEach, expect, test } from "bun:test";
import {
  changeScreen,
  entrance,
} from "../src/renderer/components/openteam/setup/screen-transition";

const realDocument = globalThis.document;
afterEach(() => {
  globalThis.document = realDocument;
});

const fakeDocument = (startViewTransition?: (update: () => void) => unknown) => {
  const root = { dataset: {} as Record<string, string> };
  globalThis.document = { documentElement: root, startViewTransition } as unknown as Document;
  return root;
};

test("without view transitions the screen changes at once", () => {
  const root = fakeDocument();
  let changed = false;
  changeScreen(() => {
    changed = true;
  });
  expect(changed).toBe(true);
  expect(root.dataset.setupDirection).toBeUndefined();
});

test("a view transition carries its direction until it finishes", async () => {
  let finish!: () => void;
  const root = fakeDocument((update) => {
    update();
    return {
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished: new Promise<void>((resolve) => (finish = resolve)),
    };
  });
  let changed = false;
  changeScreen(() => {
    changed = true;
  }, "back");
  expect(changed).toBe(true);
  expect(root.dataset.setupDirection).toBe("back");
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(root.dataset.setupDirection).toBeUndefined();
});

test("a screen change that skips the one before leaves no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const skipped = () => Promise.reject(new DOMException("Transition was skipped", "AbortError"));
    const root = fakeDocument((update) => {
      update();
      return { ready: skipped(), updateCallbackDone: Promise.resolve(), finished: skipped() };
    });
    changeScreen(() => {});
    changeScreen(() => {}, "back");
    await Bun.sleep(10);
    expect(unhandled).toEqual([]);
    expect(root.dataset.setupDirection).toBeUndefined();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a first appearance plays its entrance; a view transition brings things in itself", () => {
  expect(entrance(null, false)).toEqual({ mode: "enter", resumeAt: 0 });
  expect(entrance(null, true)).toEqual({ mode: "transition", resumeAt: 0 });
  expect(entrance(200, true)).toEqual({ mode: "transition", resumeAt: 0 });
});

test("mounted again moments later, an entrance carries on; long after, it stays put", () => {
  // The first-run frame's server check handing over to the real one.
  expect(entrance(180, false)).toEqual({ mode: "enter", resumeAt: 180 });
  // Back on a screen seen a while ago.
  expect(entrance(5_000, false)).toEqual({ mode: null, resumeAt: 0 });
});

test("each screen change moves the stage's camera a step in its direction", () => {
  const root = fakeDocument() as { dataset: Record<string, string>; style?: unknown };
  const properties = new Map<string, string>();
  root.style = { setProperty: (name: string, value: string) => properties.set(name, value) };
  changeScreen(() => {});
  const first = Number(properties.get("--setup-camera"));
  changeScreen(() => {});
  expect(Number(properties.get("--setup-camera"))).toBe(first + 1);
  changeScreen(() => {}, "back");
  changeScreen(() => {}, "back");
  expect(Number(properties.get("--setup-camera"))).toBe(first - 1);
});
