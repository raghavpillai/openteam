import { expect, test } from "bun:test";
import { pluginRuntimeContext } from "../src/plugins";

test("workers load installed tools and skills without grants, enablements or review policies", async () => {
  const installation={name:"Fixture",pluginKey:"fixture",version:"1",status:"disabled",mode:"disabled",manifest:{skills:[{name:"Fixture workflow",body:"Run the requested workflow."}],files:{}}};
  const context=await pluginRuntimeContext({
    botPluginConnectionGrant:new Proxy({},{get(){throw new Error("Retired grant query");}}),
    botPluginEnablement:new Proxy({},{get(){throw new Error("Retired enablement query");}}),
    pluginConnection:{findMany:async()=>[{id:"connection",alias:"default",name:"Fixture",connectorKey:"fixture",status:"ready",installation,
      toolSnapshot:[{name:"write",description:"Fixture write",inputSchema:{type:"object"}}]}]},
    pluginInstallation:{findMany:async()=>[installation]},
    pluginPrivateSkill:{findMany:async()=>[]},
  } as any,"bot");
  expect(context.dynamicNamespaces[0]?.tools.map(tool=>tool.name)).toEqual(["write"]);
  expect(context.skillInstructions).toContain("Run the requested workflow.");
});

test("unavailable connections carry their stored reason to the agent", async () => {
  const installation={name:"Fixture",pluginKey:"fixture",version:"1",status:"installed",manifest:{skills:[],files:{}}};
  const connection=(status:string,statusMessage:string|null)=>({id:status,alias:status,name:"Fixture",connectorKey:"fixture",status,statusMessage,installation,toolSnapshot:[]});
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
