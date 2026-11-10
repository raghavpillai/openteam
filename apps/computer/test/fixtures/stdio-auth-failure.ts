import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../src/mcp-manager";

const directory = await mkdtemp(join(tmpdir(), "mcp-auth-"));
const manager = new StdioMcpManager(directory, 3000);
const secret = "xoxc-test-secret-never-display";
const config = {
  command: "node", args: [join(import.meta.dir, "gated-mcp.mjs"), directory],
  env: { MCP_FIXTURE_AUTH_FAILURE: "yes", MCP_FIXTURE_SECRET: secret },
};
const originalError = console.error;
const logs: string[] = [];
console.error = (...args) => logs.push(args.join(" "));
try {
  const startup = { ...config, env: { ...config.env, MCP_FIXTURE_EXIT_BEFORE_INIT: "yes" } };
  await assert.rejects(manager.discover("startup", startup), /Authentication failed: Slack rejected/);
  assert.match(manager.status("startup").error!, /same current Slack session/);
  await assert.rejects(manager.discover("startup", startup), /Authentication failed: Slack rejected/);
  assert.equal((await readFile(join(directory, "starts"), "utf8")).trim().split("\n").length, 1);

  await writeFile(join(directory, "approved"), "yes");
  await manager.discover("connected", config);
  await manager.call("connected", config, "pid", { exit: true });
  const deadline = Date.now() + 3000;
  while (manager.status("connected").state !== "error") {
    assert.ok(Date.now() < deadline);
    await Bun.sleep(10);
  }
  assert.match(manager.status("connected").error!, /Authentication failed: Slack rejected/);
  assert.ok(!JSON.stringify(manager.status("connected")).includes(secret));
  assert.ok(!logs.join("\n").includes(secret));
  assert.ok(logs.join("\n").includes("[REDACTED]"));
} finally {
  await manager.closeAll();
  await rm(directory, { recursive: true, force: true });
  console.error = originalError;
}
