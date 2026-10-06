// Run against the exported package in an offline Linux OpenTeam computer image.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledTools, runServer } from "../server.mjs";

const directory = await mkdtemp(join(tmpdir(), "slack-protocol-smoke-"));
let child;
const timeout = setTimeout(() => child?.kill(), 15_000);
try {
  // The packaged launcher must reject missing credentials before starting a provider process.
  await assert.rejects(runServer(), /Enter a valid Slack browser token/);
  const preload = join(directory, "offline-provider.mjs");
  const launchRecord = join(directory, "launch.json");
  // Only the test process replaces synthetic credentials with upstream's offline demo mode.
  // Production still validates credentials, verifies/extracts the binary, forwards stdio and cleans up.
  await writeFile(preload, `
    import assert from "node:assert/strict";
    import { statSync, writeFileSync } from "node:fs";
    const spawn = Bun.spawn;
    Bun.spawn = (args, options) => {
      assert.equal(options.env.SLACK_MCP_XOXC_TOKEN, "xoxc-synthetic");
      assert.equal(options.env.SLACK_MCP_XOXD_TOKEN, "xoxd-synthetic");
      assert.equal(options.env.SLACK_MCP_XOXP_TOKEN, undefined);
      assert.equal(options.env.XDG_CACHE_HOME, options.cwd + "/cache");
      assert.ok(options.cwd.startsWith(options.env.HOME + "/.cache/openteam/slack-stealth/session-"));
      assert.equal(statSync(args[0]).mode & 0o777, 0o700);
      writeFileSync(${JSON.stringify(launchRecord)}, JSON.stringify({ directory: options.cwd }));
      return spawn([...args, "--no-cache"], { ...options, env: {
        ...options.env, SLACK_MCP_XOXC_TOKEN: "demo", SLACK_MCP_XOXD_TOKEN: "demo"
      }});
    };
  `);
  child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../server.mjs")], {
    cwd: directory,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SLACK_MCP_XOXC_TOKEN: "xoxc-synthetic",
      SLACK_MCP_XOXD_TOKEN: "xoxd-synthetic",
      SLACK_MCP_XOXP_TOKEN: "must-not-be-inherited",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let pending = "";
  const line = async () => {
    while (!pending.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("MCP process exited before replying: " + await new Response(child.stderr).text());
      pending += new TextDecoder().decode(value);
    }
    const end = pending.indexOf("\n");
    const message = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    return message;
  };
  const send = async (message) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    await child.stdin.flush();
  };
  await send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openteam-offline-test", version: "1.0.0" } } });
  assert.equal((await line()).id, 1);
  await send({ method: "notifications/initialized" });
  await send({ id: 2, method: "tools/list", params: {} });
  const response = await line();
  assert.equal(response.id, 2);
  const tools = response.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...enabledTools].sort());
  for (const name of ["conversations_add_message", "reactions_add", "reactions_remove"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool.inputSchema.properties);
    assert.equal(tool.annotations?.readOnlyHint, false);
  }
  await send({ id: 3, method: "tools/call", params: { name: "conversations_history", arguments: {} } });
  const invalid = await line();
  assert.equal(invalid.id, 3);
  assert.ok(invalid.error || invalid.result?.isError, "Invalid input must fail without calling Slack");
  child.stdin.end();
  const code = await child.exited;
  assert.equal(code, 0);
  const launch = JSON.parse(await readFile(launchRecord, "utf8"));
  await assert.rejects(stat(launch.directory), { code: "ENOENT" });
  console.log(JSON.stringify({ architecture: process.arch, tools: tools.length, invalidInputRejected: true, launcherCleanup: true, offline: true }));
} finally {
  clearTimeout(timeout);
  child?.kill();
  await rm(directory, { recursive: true, force: true });
}
