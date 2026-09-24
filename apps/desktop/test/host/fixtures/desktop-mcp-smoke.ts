import assert from "node:assert/strict";
const cases: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMcpManager } from "../../../src/main/host/mcp";
import { startHostBridge } from "../../../src/main/host/bridge";
import { DesktopMcpClient } from "../../../../computer/src/desktop-mcp-client";
import { McpRuntimeRouter } from "../../../../computer/src/mcp-runtime-router";
import { StdioMcpManager } from "../../../../computer/src/mcp-manager";
import type { PermissionSettingsStore } from "../../../src/main/permission-settings";

let directory: string;
let executable: string;
let manager: HostMcpManager;
const configuration = { runtime: "desktop", provider: "1password", command: "1password-mcp" };
const setup = async () => {
  directory = await mkdtemp(join(tmpdir(), "openteam-desktop-mcp-test-"));
  executable = join(directory, "fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
let authenticated = false;
const tools = [
  {name:"authenticate",description:"Authenticate",inputSchema:{type:"object",properties:{}}},
  {name:"list_environments",description:"List environments",inputSchema:{type:"object",properties:{accountId:{type:"string"}},required:["accountId"]},annotations:{readOnlyHint:true}}
];
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize" && existsSync(fileURLToPath(import.meta.url) + ".init-deny")) {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32000,message:"Fixture startup blocked"}}) + "\\n");
    continue;
  }
  let result;
  if (request.method === "initialize") result = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"1Password test double",version:"1.0.0"}};
  else if (request.method === "tools/list") result = {tools};
  else if (request.method === "tools/call") {
    if (request.params.name === "authenticate") authenticated = !existsSync(fileURLToPath(import.meta.url) + ".deny");
    result = {isError:!authenticated,content:[{type:"text",text:JSON.stringify({authenticated,processId:process.pid,accountId:request.params.arguments.accountId ?? "fixture",secretInherited:Boolean(process.env.OPENTEAM_CONTROL_TOKEN || process.env.OP_SERVICE_ACCOUNT_TOKEN)})}]};
  }
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result}) + "\\n");
}
`);
  await chmod(executable, 0o700);
  manager = new HostMcpManager(async () => executable);
};
const cleanup = async () => { await manager?.closeAll(); await rm(directory, { recursive: true, force: true }); };

test("authenticates before readiness, isolates connections, and closes/reopens processes", async () => {
  const first = await manager.handle({ connectionId: "first", operation: "discover", provider: "1password" });
  assert.equal((first.tools as unknown[]).length, 2);
  const call = async (id: string) => {
    const { result } = await manager.handle({ connectionId: id, operation: "call", provider: "1password", toolName: "list_environments", arguments: { accountId: id } });
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
  };
  const a = await call("first");
  await manager.handle({ connectionId: "second", operation: "discover", provider: "1password" });
  const b = await call("second");
  assert.equal(a.authenticated, true);
  assert.equal(a.secretInherited, false);
  assert.equal(a.accountId, "first");
  assert.equal(b.accountId, "second");
  assert.notEqual(a.processId, b.processId);
  await manager.close("first");
  await manager.handle({ connectionId: "first", operation: "discover", provider: "1password" });
  assert.notEqual((await call("first")).processId, a.processId);
});

test("startup failure explains recovery and a fresh connection succeeds after retry", async () => {
  await writeFile(executable + ".init-deny", "blocked");
  try {
    await assert.rejects(manager.handle({ connectionId: "startup", operation: "discover", provider: "1password" }), /macOS privacy prompt for OpenTeam/);
  } finally { await rm(executable + ".init-deny"); }
  const result = await manager.handle({ connectionId: "startup", operation: "discover", provider: "1password" });
  assert.equal((result.tools as unknown[]).length, 2);
});

test("disabled authorization fails despite successful tool listing, and retry recovers", async () => {
  await writeFile(executable + ".deny", "disabled");
  try {
    await assert.rejects(manager.handle({ connectionId: "disabled", operation: "discover", provider: "1password" }), /could not authorize/);
  } finally { await rm(executable + ".deny"); }
  const result = await manager.handle({ connectionId: "disabled", operation: "discover", provider: "1password" });
  assert.equal((result.tools as unknown[]).length, 2);
});

test("Bot routing uses the authenticated desktop bridge without spawning a Bot process", async () => {
  const bridge = await startHostBridge({
    token: "desktop-mcp-test-token", port: 0, terminalDir: directory,
    permissionSettings: {} as PermissionSettingsStore, autoReviewMode: "enforce",
    reviewAction: async () => { throw new Error("No general host action should be requested"); },
    runJob: async () => { throw new Error("No host shell job should run"); }, mcp: manager,
  });
  const address = bridge.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const desktop = new DesktopMcpClient("desktop-mcp-test-token", url);
  const computer = new StdioMcpManager(join(directory, "packages"));
  const router = new McpRuntimeRouter(computer, desktop);
  try {
    await assert.rejects(new DesktopMcpClient("wrong", url).request("routed", "discover", configuration), /unauthorized/);
    assert.equal((await router.discover("routed", configuration)).length, 2);
    const result = await router.call("routed", configuration, "list_environments", { accountId: "routed" }) as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0]!.text).accountId, "routed");
    await assert.rejects(router.discover("bad", { ...configuration, command: "sh" }), /Unsupported/);
    const response = await fetch(`${url}/v1/mcp`, { method: "POST", headers: { authorization: "Bearer desktop-mcp-test-token", "content-type": "application/json" }, body: JSON.stringify({ connectionId: "bad", operation: "discover", provider: "shell" }) });
    assert.equal(response.status, 400);
  } finally {
    await router.closeAll();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  }
});

await setup();
try {
  for (const item of cases) { await item.run(); console.log(`PASS: ${item.name}`); }
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({passed: cases.map(item => item.name)}));
} finally { await cleanup(); }
