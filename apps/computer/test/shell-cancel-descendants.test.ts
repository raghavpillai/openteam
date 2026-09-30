import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";

for (const command of ["echo READY; sleep 3; echo UNEXPECTED", "trap '' TERM; echo READY; sleep 3; echo UNEXPECTED", "(trap '' TERM; sleep 3) & wait; echo UNEXPECTED"]) test(`foreground cancellation stops descendants: ${command}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-shell-cancel-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({agentDir: root, controlToken: "fixture"});
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const result = await executor.shell({command, block_until_ms: 5000}, root, controller.signal);
    expect(JSON.stringify(result.content)).not.toContain("UNEXPECTED");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { clearTimeout(timer); await rm(root, {recursive: true, force: true}); }
});
