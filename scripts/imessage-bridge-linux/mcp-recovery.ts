import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StdioMcpManager } from "../../apps/computer/src/mcp-manager";

const host = process.argv[2]!;
const configuration = {
  command: "/usr/bin/python3",
  args: ["/tmp/imessage-bridge-fixture.py", "adapter"],
  env: { FIXTURE_BRIDGE: `http://${host}:8799/mcp` },
};
const manager = new StdioMcpManager("/tmp/bridge-mcp-cache", 5000);
const control = async (action: string) => {
  const response = await fetch(`http://${host}:8787/${action}`, { method: "POST" });
  assert.equal(response.status, 200);
};
const status = () => manager.call("bridge", configuration, "IMessageStatus", {});
const readable = (value: unknown) => {
  const result = value as { isError?: boolean; content: Array<{ type: string; text: string }> };
  assert.notEqual(result.isError, true);
  const content = result.content.find((item) => item.type === "text");
  assert.ok(content);
  assert.equal(JSON.parse(content.text).readable, true);
};
const starts = () => readFileSync("/tmp/bridge-adapter-starts", "utf8").trim().split("\n").length;

try {
  await control("start");
  // Ready connections start lazily after the computer loses its process state.
  readable(await status());
  const before = starts();
  const replies = await Promise.all(Array.from({ length: 8 }, () => status()));
  replies.forEach(readable);
  assert.equal(starts(), before);
  await manager.closeAll();
  readable(await status());
  assert.equal(starts(), before + 1);

  // A running adapter recovers when its host bridge comes back.
  await control("stop");
  await assert.rejects(status());
  await control("start");
  readable(await status());

  // A failed startup stays visible until the normal explicit reconnect.
  await manager.closeAll();
  await control("stop");
  await assert.rejects(manager.discover("bridge", configuration));
  assert.equal(manager.status("bridge").state, "error");
  await control("start");
  await assert.rejects(status());
  await manager.close("bridge", 1);
  const tools = await manager.discover("bridge", configuration, 1);
  assert.equal((tools[0] as { name: string }).name, "IMessageStatus");
  readable(await manager.call("bridge", configuration, "IMessageStatus", {}, 1));

  // Invalid saved credentials fail startup and recover through explicit reconnect.
  const invalid = {
    ...configuration,
    env: { ...configuration.env, FIXTURE_BRIDGE_TOKEN: "invalid-fixture-token" },
  };
  await assert.rejects(manager.discover("invalid-token", invalid));
  assert.equal(manager.status("invalid-token").state, "error");
  await assert.rejects(manager.discover("invalid-token", configuration));
  await manager.close("invalid-token", 1);
  await manager.discover("invalid-token", configuration, 1);
  readable(await manager.call("invalid-token", configuration, "IMessageStatus", {}, 1));
  console.log(
    "MCP restart, concurrency, bridge outage, credentials, and explicit reconnect passed"
  );
} finally {
  await manager.closeAll();
}
