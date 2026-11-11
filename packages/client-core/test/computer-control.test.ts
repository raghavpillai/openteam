import { expect, test } from "bun:test";
import { createComputerControlController, ownsComputerControl } from "../src/computer-control";
import type { ScreenStatusView } from "@openteam/contracts";
const status = (id: string | null, generation = 1) =>
  ({ humanTakeover: !!id, controlSession: id ? { id, generation } : null }) as ScreenStatusView;
test("closing during acquisition releases the returned generation without a render", async () => {
  let complete!: (s: ScreenStatusView) => void;
  const calls: unknown[] = [];
  const c = createComputerControlController("desktop", async (active, input) => {
    calls.push({ active, ...input });
    return active
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : status(null);
  });
  c.open();
  const pending = c.take();
  const closing = c.close();
  complete(status("desktop", 42));
  await Promise.all([pending, closing]);
  expect(calls).toEqual([
    { active: true, controlId: "desktop", force: false },
    { active: false, controlId: "desktop", generation: 42 },
  ]);
});
test("watching a different owner never releases their session", async () => {
  let calls = 0;
  const c = createComputerControlController("ios", async () => {
    calls++;
    return status(null);
  });
  c.open();
  c.observe(status("desktop"));
  await c.close();
  expect(calls).toBe(0);
  expect(ownsComputerControl(status("desktop"), "ios")).toBe(false);
});
test("reconnection observes existing ownership without issuing acquisition or renewals", async () => {
  const calls: unknown[] = [];
  const c = createComputerControlController("desktop", async (active, input) => {
    calls.push({ active, ...input });
    return status(null);
  });
  c.open();
  c.observe(status("desktop", 3));
  c.observe(status("desktop", 3));
  expect(calls).toEqual([]);
  await c.giveBack();
  expect(calls).toEqual([{ active: false, controlId: "desktop", generation: 3 }]);
});
test("unsupported servers cannot silently acquire a renewable legacy lease", async () => {
  const c = createComputerControlController(
    "desktop",
    async () => ({ humanTakeover: true }) as ScreenStatusView
  );
  await expect(c.take()).rejects.toThrow("Update your OpenTeam server");
});
