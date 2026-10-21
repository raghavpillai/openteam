import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTools } from "../../src/runtime/tools";
import { performComputerUseBatch } from "../../src/screen/actions";

test("stopping a native call prevents the rest of its action batch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "native-cancel-"));
  const controller = new AbortController();
  const applied: string[] = [];
  const runtime: any = Object.create(RuntimeTools.prototype);
  // Auto-review off: these tests exercise the native tools themselves.
  runtime.autoReview = { reviewComputer: async () => {}, reviewBrowser: async () => {}, reviewShell: async () => {}, reviewMcp: async () => {}, assertNoPending() {} };
  Object.assign(runtime, {
    workspaceRoot: workspace,
    screens: {
      actComputerUse: async (_bot: string, _cwd: string, actions: any[], signal?: AbortSignal) => {
        await performComputerUseBatch(actions, async action => {
          applied.push(action.action);
          controller.abort(new Error("Stopped by user"));
        }, signal);
        throw new Error("Batch continued after cancellation");
      },
    },
  });
  try {
    await expect(runtime.callComputerUse(
      { botId: "worker", screenBotId: "owner", cwd: workspace, lastGraphicalSurface: "computer" },
      { action: "click", x: 10, y: 10, then: [{ action: "type", text: "must not be typed" }] },
      controller.signal)).rejects.toThrow("Stopped by user");
    expect(applied).toEqual(["click"]);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

// Exercise the actual Computer result path. A browser-start request changes the
// foreground window after the frame was captured, invalidating returned evidence.
test("native screenshot observation does not request a browser launch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "native-observation-"));
  const events: string[] = [];
  const frame = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4////fwAJ+wP92PZgeAAAAABJRU5ErkJggg==", "base64");
  const runtime: any = Object.create(RuntimeTools.prototype);
  // Auto-review off: these tests exercise the native tools themselves.
  runtime.autoReview = { reviewComputer: async () => {}, reviewBrowser: async () => {}, reviewShell: async () => {}, reviewMcp: async () => {}, assertNoPending() {} };
  Object.assign(runtime, {
    workspaceRoot: workspace,
    screens: {
      actComputerUse: async () => { events.push("capture-native-frame"); return frame; },
      browserEndpointForAgent: async () => { events.push("request-browser-launch"); throw new Error("no browser open"); },
    },
    browserUseSessions: new Map(), browserSessionScreens: new Map(),
  });
  try {
    const result = await runtime.callComputerUse({botId: "worker", screenBotId: "owner", cwd: workspace, lastGraphicalSurface: "computer"}, {action: "screenshot"});
    expect(result.details.coordinateSpace).toBe("desktop");
    expect(events).toEqual(["capture-native-frame"]);
  } finally { await rm(workspace, {recursive: true, force: true}); }
});

test("explicit browser operation retains intentional launch path", async () => {
  const runtime: any=Object.create(RuntimeTools.prototype);
  // Auto-review off: these tests exercise the native tools themselves.
  runtime.autoReview = { reviewComputer: async () => {}, reviewBrowser: async () => {}, reviewShell: async () => {}, reviewMcp: async () => {}, assertNoPending() {} };
  const browser={connected:true};const events:string[]=[];
  Object.assign(runtime, {
    screens:{browserEndpointForAgent:async()=>{events.push("launch");return "new-endpoint";}},
    formBrowser:async (_id:string,endpoint:string)=>events.push(endpoint),
    browserUseSessions:new Map([["owner",browser]]),browserSessionScreens:new Map(),
  });
  expect(await runtime.privateBrowser({screenBotId:"owner",cwd:"/workspace"})).toBe(browser);
  expect(events).toEqual(["launch","new-endpoint"]);
});

test("Screenshot and Computer results use the reference sentences and prefix failures", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "native-wording-"));
  const frame = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4////fwAJ+wP92PZgeAAAAABJRU5ErkJggg==", "base64");
  let fail = false;
  const runtime: any = Object.create(RuntimeTools.prototype);
  // Auto-review off: these tests exercise the native tools themselves.
  runtime.autoReview = { reviewComputer: async () => {}, reviewBrowser: async () => {}, reviewShell: async () => {}, reviewMcp: async () => {}, assertNoPending() {} };
  Object.assign(runtime, {
    workspaceRoot: workspace,
    screens: {
      actComputerUse: async () => { if (fail) throw new Error("display unavailable"); return frame; },
      screenshot: async () => { if (fail) throw new Error("display unavailable"); return frame; },
    },
  });
  const active = { botId: "worker", screenBotId: "owner", cwd: workspace, lastGraphicalSurface: "computer" };
  try {
    const action = await runtime.callComputerUse(active, { action: "click", x: 1, y: 1 });
    expect(action.content[0].text).toBe(`Computer action ran on the box desktop.\nScreenshot of the resulting screen saved to ${action.details.path}, and if it should be shown to the user, include this file:// path in your report to the parent.`);
    const shot = await runtime.executeScopedTool({ ...active, runtimeProfile: "agent" }, "shot", "Screenshot", {});
    expect(shot.content[0].text).toBe(`Screenshot captured from the box desktop.\nScreenshot saved to ${shot.details.path}, and to show the user the box, attach this file:// path with SendToUser.`);
    fail = true;
    await expect(runtime.callComputerUse(active, { action: "click", x: 1, y: 1 })).rejects.toThrow("Computer action failed: display unavailable");
    await expect(runtime.executeScopedTool({ ...active, runtimeProfile: "agent" }, "shot", "Screenshot", {})).rejects.toThrow("Screenshot failed: display unavailable");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
