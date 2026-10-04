import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../src/mcp-manager";

const directory = await mkdtemp(join(tmpdir(), "mcp-login-"));
const manager = new StdioMcpManager(directory, 800);
const config = { command: "node", args: [join(import.meta.dir, "gated-mcp.mjs"), directory] };
const starts = async () =>
  (await readFile(join(directory, "starts"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean);
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await Bun.sleep(10);
  }
}
try {
  const pending = Array.from({ length: 12 }, () => manager.discover("ramp", config));
  await waitFor(async () => (await starts()).length === 1);
  for (let i = 0; i < 20; i++) {
    assert.equal(manager.status("ramp").state, "starting");
    assert.equal(manager.status("unknown").state, "stopped");
    await Bun.sleep(10);
  }
  assert.equal(
    (await starts()).length,
    1,
    "concurrent requests and health checks must share one login"
  );
  await writeFile(join(directory, "approved"), "yes");
  assert.ok((await Promise.all(pending)).every((tools) => tools.length === 1));
  assert.equal(manager.status("ramp").state, "ready");
  const pid = (await starts())[0];
  assert.ok(JSON.stringify(await manager.call("ramp", config, "pid", {})).includes(pid!));
  await manager.call("ramp", config, "pid", { exit: true });
  await waitFor(() => manager.status("ramp").state === "error");
  await assert.rejects(manager.discover("ramp", config), /Reconnect/);
  assert.equal((await starts()).length, 1, "an exited process must not be automatically replaced");

  await manager.close("ramp");
  await rm(join(directory, "approved"));
  await assert.rejects(manager.discover("ramp", config));
  assert.equal(manager.status("ramp").state, "error");
  for (let i = 0; i < 5; i++) await assert.rejects(manager.discover("ramp", config), /Reconnect/);
  assert.equal((await starts()).length, 2, "expired login must require explicit reconnect");

  await manager.close("ramp");
  const cancelled = manager.discover("ramp", config);
  void cancelled.catch(() => {});
  await waitFor(async () => (await starts()).length === 3);
  await manager.close("ramp");
  await assert.rejects(cancelled);
  assert.equal(manager.status("ramp").state, "stopped");
  await writeFile(join(directory, "approved"), "yes");
  assert.equal((await manager.discover("ramp", config)).length, 1);
  assert.equal((await starts()).length, 4, "explicit reconnect starts exactly one new process");
  await assert.rejects(
    manager.discover("ramp", { ...config, args: [...config.args, "changed-launch"] }),
    /configuration changed/
  );
  assert.equal((await starts()).length, 4, "stale configuration cannot replace a live login");
  const rotated = { ...config, env: { ACCESS_TOKEN: "rotated-host-token" } };
  assert.ok(
    (await Promise.all(Array.from({ length: 6 }, () => manager.discover("ramp", rotated)))).every(
      (tools) => tools.length === 1
    )
  );
  assert.equal(
    (await starts()).length,
    5,
    "rotating host credentials replaces a ready process once"
  );
} finally {
  await manager.closeAll();
  await rm(directory, { recursive: true, force: true });
}
