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

test("a routine handoff stops the background commands its runs started, and only those", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-shell-handoff-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({agentDir: root, controlToken: "fixture"});
  const started: string[] = [];
  const status = async (id: string, block_until_ms: number) => (await executor.awaitShell({shell_id: id, block_until_ms}, undefined, "scope")).details.status;
  try {
    const start = async (automationRunId?: string) => {
      const result = await executor.shell({command: "sleep 2", block_until_ms: 50}, root, undefined, undefined, "scope", automationRunId ? {automationRunId} : {});
      started.push(/Shell ID: (\d+)/.exec(JSON.stringify(result.content))![1]!);
      return started.at(-1)!;
    };
    const [first, second, other, parent] = [await start("routine-run"), await start("routine-continuation"), await start("another-routine"), await start()];
    expect(executor.stopAutomationShells(["routine-run", "routine-continuation"])).toBe(2);
    expect(await status(first, 1000)).toBe("completed");
    expect(await status(second, 1000)).toBe("completed");
    expect(await status(other, 0)).toBe("running");
    expect(await status(parent, 0)).toBe("running");
  } finally {
    for (const id of started) await status(id, 5000).catch(() => undefined);
    await rm(root, {recursive: true, force: true});
  }
});
