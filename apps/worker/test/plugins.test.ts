import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore } from "@openteam/messaging";
import { pluginRuntimeContext, pluginSkillInstructions } from "../src/plugins";
import { pluginSkillAgent, subagentLoadsPluginContext, subagentRuntimeOwners } from "../src/worker";

const updatedAt = new Date("2026-10-14T12:00:00.000Z");
const manifest = {
  key: "fixture",
  name: "Fixture",
  version: "1",
  publisher: "OpenTeam",
  files: {},
  skills: [
    { name: "main-only", description: "Main", body: "Main agent workflow.", path: "skills/main-only" },
    { name: "sign-in", description: "Sign in", body: "Shared sign-in workflow.", path: "skills/sign-in", agents: ["main", "computerUse"] },
  ],
};
const installation = { name: "Fixture", pluginKey: "fixture", version: "1", status: "installed", manifest };
const privateSkill = { id: "private", name: "Private", description: "Private", body: "Private workflow.", updatedAt };
const prisma = {
  pluginConnection: { findMany: async () => [] },
  pluginInstallation: { findMany: async () => [installation] },
  pluginPrivateSkill: { findMany: async () => [privateSkill] },
} as any;

let root = "";
const previousRoot = process.env.OPENTEAM_AGENT_DATA_ROOT;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteam-worker-skills-"));
  process.env.OPENTEAM_AGENT_DATA_ROOT = root;
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
  else process.env.OPENTEAM_AGENT_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

const syncCache = () =>
  new AgentDataStore({} as never, { root, workspaceRoot: join(root, "workspace") }).syncPluginSkillCache([
    { id: "fixture", name: "Fixture", version: "1", publisher: "OpenTeam", skills: manifest.skills, files: manifest.files },
    { id: "private-private", name: "Private", version: updatedAt.toISOString(), publisher: "Private", skills: [{ ...privateSkill, path: "skills/private" }], files: {} },
  ]);

test("workers load installed tools and skills without grants, enablements or review policies", async () => {
  const installation={name:"Fixture",pluginKey:"fixture",version:"1",status:"disabled",mode:"disabled",manifest:{skills:[{name:"Fixture workflow",body:"Run the requested workflow."}],files:{}}};
  const context=await pluginRuntimeContext({
    botPluginConnectionGrant:new Proxy({},{get(){throw new Error("Retired grant query");}}),
    botPluginEnablement:new Proxy({},{get(){throw new Error("Retired enablement query");}}),
    pluginConnection:{findMany:async()=>[{id:"connection",alias:"default",name:"Fixture",createdAt:new Date(0),connectorKey:"fixture",status:"ready",installation,
      toolSnapshot:[{name:"write",description:"Fixture write",inputSchema:{type:"object"}}]}]},
    pluginInstallation:{findMany:async()=>[installation]},
    pluginPrivateSkill:{findMany:async()=>[]},
  } as any,"bot");
  expect(context.dynamicNamespaces[0]?.tools.map(tool=>tool.name)).toEqual(["write"]);
  // A pattern search by service name finds the namespace.
  expect(context.dynamicNamespaces[0]?.name).toBe("fixture");
  expect(context.skillInstructions).toContain("Run the requested workflow.");
});

test("unavailable connections carry their stored reason to the agent", async () => {
  const installation={name:"Fixture",pluginKey:"fixture",version:"1",status:"installed",manifest:{skills:[],files:{}}};
  const connection=(status:string,statusMessage:string|null)=>({id:status,alias:status,name:"Fixture",createdAt:new Date(status.length),connectorKey:"fixture",status,statusMessage,installation,toolSnapshot:[]});
  const context=await pluginRuntimeContext({
    pluginConnection:{findMany:async()=>[
      connection("error","Local runtime unavailable: MCP process exited. Reconnect to try again."),
      connection("ready","Earlier failure"),
    ]},
    pluginInstallation:{findMany:async()=>[installation]},
    pluginPrivateSkill:{findMany:async()=>[]},
  } as any,"bot");
  expect(context.dynamicNamespaces.map(namespace=>[namespace.namespaceStatus,namespace.statusMessage])).toEqual([
    ["error","Local runtime unavailable: MCP process exited. Reconnect to try again."],
    ["ready",undefined],
  ]);
});

test("the main agent's prompt carries saved connector instructions; workers' prompts do not", async () => {
  const installation={name:"Slack",pluginKey:"slack",version:"1",status:"installed",manifest:{skills:[],files:{}}};
  const prisma={
    pluginConnection:{findMany:async()=>[{id:"slack",alias:"default",name:"Slack",createdAt:new Date(0),connectorKey:"slack",status:"ready",statusMessage:null,
      instructions:"Reply in threads.",installation,toolSnapshot:[{name:"post",description:"Post",inputSchema:{type:"object"}}]}]},
    pluginInstallation:{findMany:async()=>[installation]},
    pluginPrivateSkill:{findMany:async()=>[]},
  } as any;
  const main=await pluginRuntimeContext(prisma,"bot","main");
  expect(main.skillInstructions).toStartWith("\n\n## Connector custom instructions\nCustom instructions are configured for some connected tools (MCP connectors).");
  expect(main.skillInstructions).toContain("- Slack (default), namespace slack: Reply in threads.");
  expect(main.dynamicNamespaces[0]!.description).toBe("Slack (default)");
  expect((await pluginRuntimeContext(prisma,"bot","executor")).skillInstructions).not.toContain("Reply in threads.");
});

test("agents a skill names keep its full text, and untyped workers get no skills", async () => {
  await syncCache();
  const worker = await pluginSkillInstructions(prisma, "child", "computerUse");
  expect(worker).toContain("Shared sign-in workflow.");
  expect(await pluginSkillInstructions(prisma, "child", null)).toBe("");
});

test("subagent runtime ownership: screens, plugin tools and skill agents", () => {
  expect(subagentRuntimeOwners("bot", null)).toEqual({ screenBotId: "bot", pluginBotId: "bot" });
  // The computerUse worker drives the parent desktop.
  expect(subagentRuntimeOwners("child", { parentBotId: "parent", subagentType: "computerUse" })).toMatchObject({ screenBotId: "parent" });
  // Executor and knowledgeWork workers inherit parent plugin tools without sharing its screen.
  for (const subagentType of ["executor", "knowledgeWork"])
    expect(subagentRuntimeOwners("child", { parentBotId: "parent", subagentType })).toEqual({ screenBotId: "child", pluginBotId: "parent" });
  // Graphical and media workers never receive plugin tools or runtime packages.
  for (const [type, loads] of [["computerUse", false], ["videoReview", false], ["watchVideo", false], ["executor", true], ["knowledgeWork", true], [null, true]] as const)
    expect(subagentLoadsPluginContext(type)).toBe(loads);
  expect(pluginSkillAgent("agent", null)).toBe("main");
  expect(pluginSkillAgent("subagent", "computerUse")).toBe("computerUse");
  expect(pluginSkillAgent("subagent", null)).toBeNull();
});
