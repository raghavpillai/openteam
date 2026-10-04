import { expect, test } from "bun:test";
import { normalizeKey, performComputerUseBatch } from "../src/screen/actions";
import { inferenceFailure } from "../src/inference-error";
import { RuntimeTools } from "../src/runtime/tools";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("punctuation and modifier spellings form valid X11 key chords", () => {
  expect(normalizeKey("ctrl+-")).toBe("ctrl+minus");
  expect(normalizeKey("Control++")).toBe("ctrl+plus");
  expect(normalizeKey("+")).toBe("plus");
  expect(normalizeKey("ControlOrMeta+Shift+[" )).toBe("ctrl+Shift+bracketleft");
  expect(normalizeKey("alt+F4")).toBe("alt+F4");
  expect(normalizeKey("shift+f12")).toBe("shift+F12");
  expect(normalizeKey("ctrl+f1")).toBe("ctrl+F1");
  expect(normalizeKey("f35")).toBe("F35");
});

test("a partial Computer batch reports its applied prefix and does not execute later actions", async () => {
  const observed: string[] = [];
  await expect(performComputerUseBatch([
    { action: "type", text: "synthetic text" },
    { action: "key", key: "unsupported-key" },
    { action: "type", text: "must not run" },
  ], async action => {
    observed.push(action.action);
    if (action.action === "key") throw new Error("Unsupported key");
  })).rejects.toThrow("action 2 of 3 (key). 1 earlier action(s) completed; later actions were not executed");
  expect(observed).toEqual(["type", "key"]);
  const abort = new AbortController();
  abort.abort(new Error("Stopped by user"));
  await expect(performComputerUseBatch([{ action: "screenshot" }], async () => {
    throw new Error("Must not run");
  }, abort.signal)).rejects.toThrow("Stopped by user");
});

test("inference failures expose useful stable codes without provider secrets", () => {
  expect(inferenceFailure(new Error("Memory inference timed out"))).toMatchObject({ status: 504, error: { code: "inference_timeout" } });
  expect(inferenceFailure(new Error("provider 401 secret-token"))).toMatchObject({ status: 422 });
  expect(JSON.stringify(inferenceFailure(new Error("upstream failure secret-token")))).not.toContain("secret-token");
});

test("switching from browser to desktop returns a fresh frame before any pointer mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinate-guard-"));
  const calls: any[] = [];
  const runtime = Object.create(RuntimeTools.prototype) as any;
  runtime.workspaceRoot = root;
  const frame = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l0AAAAASUVORK5CYII=", "base64");
  runtime.screens = { actComputerUse: async (_bot: string, _cwd: string, actions: unknown) => { calls.push(actions); return frame; } };
  runtime.privateBrowser = async () => { throw new Error("no browser fixture"); };
  const active = { botId: "test", screenBotId: "test", cwd: root, lastGraphicalSurface: "browser" };
  try {
    const first = await runtime.callComputerUse(active, { action: "drag", x: 200, y: 300, x2: 400, y2: 500 });
    expect(calls[0]).toEqual([{ action: "screenshot" }]);
    expect(first.details.requestedActionsSkipped).toBe(true);
    await runtime.callComputerUse(active, { action: "click", x: 100, y: 100 });
    expect(calls[1][0].action).toBe("click");
  } finally { await rm(root, { recursive: true, force: true }); }
});
