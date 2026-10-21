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
    // A stopped command is an interruption error with the output it printed, never a completion.
    const error = await executor.shell({command, block_until_ms: 5000}, root, controller.signal).then(() => undefined, (error: Error) => error);
    expect(error?.message).toMatch(/^Error: Shell command was interrupted by the user after \d+ms before it completed\./);
    expect(error?.message).not.toContain("UNEXPECTED");
    if (command.startsWith("echo") || command.startsWith("trap")) expect(error?.message).toContain("Output collected before interruption:\n\n```\nREADY\n\n```");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { clearTimeout(timer); await rm(root, {recursive: true, force: true}); }
});
