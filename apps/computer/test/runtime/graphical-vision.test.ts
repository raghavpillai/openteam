import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
import { assertGraphicalModel } from "../../src/inference-models";
import { tempDirs } from "../temp";
import { offlineComputerRuntime, offlineModel, piTurn, requestBody, sseStep, toolCall } from "./pi-fixtures";
const tempDir = tempDirs();

const model = offlineModel("vision-fixture", { input: ["text", "image"] });

test("computerUse rejects a text-only model before starting a session", async () => {
  const runtime = new ComputerRuntime() as any;
  runtime.modelRuntime = {};
  runtime.resolveModel = () => ({ ...model, input: ["text"] });
  let refreshes = 0;
  runtime.inferenceProviders = { verify: async () => { refreshes++; } };
  const manager = SessionManager.inMemory("/tmp");
  await expect(runtime.createStandaloneSession("/tmp", "Inspect the desktop", manager, {
    contextSessionId: manager.getSessionId(), subagentType: "computerUse", reasoning: "off",
  }, {})).rejects.toThrow("cannot inspect screenshots");
  expect(refreshes).toBe(1);
});

test("text agents and executors remain usable without vision", () => {
  const text = { ...model, input: ["text"] as ["text"] };
  expect(() => assertGraphicalModel(text, null)).not.toThrow();
  expect(() => assertGraphicalModel(text, "executor")).not.toThrow();
  expect(() => assertGraphicalModel(model, "computerUse")).not.toThrow();
});

test("a Computer screenshot reaches the model request through the real Pi tool loop", async () => {
  const root = await tempDir("graphical-vision-");
  const requests: any[] = [];
  const screenshot = await new (createJimp({ formats: [png] }))({ width: 1280, height: 800, color: 0xffffffff }).getBuffer("image/png");
  let session: any;
  try {
    const fetch = async (_url: unknown, init: any) => {
      requests.push(await requestBody(init));
      return sseStep(model, requests.length === 1 ? [toolCall(0, "capture", "Computer", { action: "screenshot" })] : "The desktop screenshot was received.", 100);
    };
    const screens = { actComputerUse: async () => screenshot };
    const runtime = await offlineComputerRuntime(model, root, fetch, new ComputerRuntime(screens as never));
    const tools = runtime.tools;
    tools.workspaceRoot = root;
    tools.privateBrowser = () => { throw new Error("No browser is needed for this native screenshot"); };
    let refreshed = false;
    let refreshes = 0;
    runtime.resolveModel = () => refreshed ? model : { ...model, input: ["text"] };
    runtime.inferenceProviders = { verify: async (settings: unknown) => {
      expect(settings).toEqual({ providerId: model.provider, modelId: model.id, reasoning: "off" });
      refreshed = true;
      refreshes++;
    } };
    runtime.compaction = new BotCompactionCoordinator(new BotCompactionArchiveStore(join(root, "archives")), 0);
    let receipt: any;
    runtime.tools = {
      customTools: () => [{
        name: "Computer", label: "Computer", description: "Inspect the native desktop",
        parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
        execute: async (id: string, args: unknown, signal: AbortSignal) => {
          receipt = await tools.callComputerUse(active, args, signal);
          return receipt;
        },
      }],
      acknowledgeToolOutcomes: async () => {},
    };
    const active: any = piTurn(model, root, {
      screenBotId: crypto.randomUUID(), instructions: "Inspect the native desktop", subagentType: "computerUse", requestSource: "subagent",
      pluginAbortController: new AbortController(),
    });
    const manager = SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId });
    session = await runtime.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
    active.session = session;
    await session.prompt("Take a desktop screenshot and inspect it.");
    expect(refreshes).toBe(1);
    expect(requests).toHaveLength(2);
    const wire = JSON.stringify(requests[1]);
    expect(wire).toContain(`data:image/png;base64,${screenshot.toString("base64")}`);
    expect(wire).not.toContain("image omitted");
    expect(receipt.details).toMatchObject({ coordinateSpace: "desktop", width: 1280, height: 800 });
    expect((await readFile(receipt.details.path)).toString("base64")).toBe(screenshot.toString("base64"));
    const stored = manager.buildSessionContext().messages as any[];
    expect(stored.find(m => m.role === "toolResult" && m.toolName === "Computer").content.some((part: any) => part.type === "image")).toBe(true);
  } finally {
    session?.dispose();
  }
});
