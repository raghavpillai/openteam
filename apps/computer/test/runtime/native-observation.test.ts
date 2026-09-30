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
      controller.signal,
    )).rejects.toThrow("Stopped by user");
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
      existingBrowserEndpointForAgent: async () => null,
    },
    browserUseSessions: new Map(), browserSessionScreens: new Map(),
  });
  try {
    const result = await runtime.callComputerUse({botId: "worker", screenBotId: "owner", cwd: workspace, lastGraphicalSurface: "computer"}, {action: "screenshot"});
    expect(result.details.coordinateSpace).toBe("desktop");
    expect(events).toEqual(["capture-native-frame"]);
  } finally { await rm(workspace, {recursive: true, force: true}); }
});

import { ScreenBroker } from "../../src/screen-broker";

test("passive endpoint probes only the requested existing desktop", async () => {
  const broker: any = Object.create(ScreenBroker.prototype);
  const probes: string[] = [];
  Object.assign(broker, {
    sessions: new Map([
      ["owner", {state:"ready", browserDebugPort:9341, humanTakeoverUntil:0, agentInputPaused:false}],
      ["other", {state:"ready", browserDebugPort:9342, humanTakeoverUntil:0, agentInputPaused:false}],
      ["starting", {state:"starting", browserDebugPort:9343}],
    ]),
    browserIsReady: async (url: string) => { probes.push(url); return true; },
    openApp: () => { throw new Error("must not launch"); },
    ensure: () => { throw new Error("must not create desktop"); },
  });
  expect(await broker.existingBrowserEndpointForAgent("missing")).toBeNull();
  expect(await broker.existingBrowserEndpointForAgent("starting")).toBeNull();
  expect(await broker.existingBrowserEndpointForAgent("owner")).toBe("http://127.0.0.1:9341");
  expect(probes).toEqual(["http://127.0.0.1:9341"]);
  broker.browserIsReady = async () => false;
  expect(await broker.existingBrowserEndpointForAgent("owner")).toBeNull();
});

test("passive observation preserves input pause and human takeover", async () => {
  const broker: any = Object.create(ScreenBroker.prototype);
  const session = {state:"ready", browserDebugPort:9341, humanTakeoverUntil:0, agentInputPaused:true};
  Object.assign(broker, {sessions:new Map([["owner",session]]), browserIsReady:async () => {throw new Error("must not probe during takeover");}});
  await expect(broker.existingBrowserEndpointForAgent("owner")).rejects.toThrow("paused");
  session.agentInputPaused=false;session.humanTakeoverUntil=Date.now()+60000;
  await expect(broker.existingBrowserEndpointForAgent("owner")).rejects.toThrow();
});

test("existing browser gets observed, unrelated browser does not", async () => {
  const runtime: any=Object.create(RuntimeTools.prototype);
  const expected={connected:true};
  const unrelated={connected:true};
  const endpoints: string[]=[];
  Object.assign(runtime, {
    screens:{existingBrowserEndpointForAgent:async (id:string)=>id==="owner"?"existing-endpoint":null,
      browserEndpointForAgent:async()=>{throw new Error("passive observation must not launch");}},
    formBrowser:async (_id:string,endpoint:string)=>{endpoints.push(endpoint);},
    browserUseSessions:new Map([["unrelated-worker",unrelated],["current-worker",expected]]),
    browserSessionScreens:new Map([["unrelated-worker","other"],["current-worker","owner"]]),
  });
  expect(await runtime.privateBrowser({screenBotId:"owner"},false)).toBe(expected);
  expect(endpoints).toEqual(["existing-endpoint"]);
  await expect(runtime.privateBrowser({screenBotId:"missing"},false)).rejects.toThrow("No live browser");
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
