import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../src/mcp-manager";
process.env.OPENTEAM_CONTROL_TOKEN = "synthetic-parent-secret-must-not-reach-connector";

const directory = await mkdtemp(join(tmpdir(), "plugin-runtime-"));
let manager = new StdioMcpManager(directory);
const configuration = {
  command: "node",
  args: ["${PLUGIN_ROOT}/server.mjs", 'argument with spaces and "quotes"'],
  cwd: "${PLUGIN_ROOT}",
  env: { PLUGIN_LABEL: "first account" },
  packageFiles: { "server.mjs": await readFile(join(import.meta.dir, "packaged-mcp.mjs"), "utf8") },
};
try {
  assert.equal((await manager.discover("first", configuration)).length, 2);
  const context = JSON.parse(
    (
      (await manager.call("first", configuration, "context", {})) as {
        content: Array<{ text: string }>;
      }
    ).content[0]!.text
  );
  assert.deepEqual(
    { argument: context.argument, label: context.label, inheritedSecret: context.inheritedSecret },
    {
      argument: 'argument with spaces and "quotes"',
      label: "first account",
      inheritedSecret: false,
    }
  );
  assert.ok(context.cwd.startsWith(await realpath(directory)));
  const second = { ...configuration, env: { PLUGIN_LABEL: "second account" } };
  assert.ok(
    JSON.stringify(await manager.call("second", second, "context", {})).includes("second account")
  );
  await manager.call("first", configuration, "echo", { text: "notification" });
  assert.equal((await manager.discover("first", configuration)).length, 3);
  await manager.closeAll();
  manager = new StdioMcpManager(directory);
  assert.ok(
    JSON.stringify(await manager.call("first", configuration, "context", {})).includes(
      "first account"
    )
  );
  await assert.rejects(
    manager.discover("invalid", { ...configuration, packageFiles: { "../escape.mjs": "no" } }),
    /Unsafe package path/
  );
} finally {
  await manager.closeAll();
  await rm(directory, { recursive: true, force: true });
}
