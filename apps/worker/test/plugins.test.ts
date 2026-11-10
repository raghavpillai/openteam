import { expect, test } from "bun:test";
import { pluginRuntimeContext } from "../src/plugins";

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
