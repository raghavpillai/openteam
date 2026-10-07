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
  const browser={connected:true};const events:string[]=[];
  Object.assign(runtime, {
    screens:{browserEndpointForAgent:async()=>{events.push("launch");return "new-endpoint";}},
    formBrowser:async (_id:string,endpoint:string)=>events.push(endpoint),
    browserUseSessions:new Map([["owner",browser]]),browserSessionScreens:new Map(),
  });
  expect(await runtime.privateBrowser({screenBotId:"owner",cwd:"/workspace"})).toBe(browser);
  expect(events).toEqual(["launch","new-endpoint"]);
});
