import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("a stopped command returns promptly even when a descendant left the process group holding its output", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-shell-cancel-setsid-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({agentDir: root, controlToken: "fixture"});
  const controller = new AbortController();
  const pidFile = join(root, "escaped.pid");
  // The descendant moves to its own session, out of reach of the group kill, and keeps stdout open.
  const command = `perl -MPOSIX -e 'setsid(); open(my $f, ">", "${pidFile}"); print $f $$; close $f; sleep 6' & echo READY; sleep 6`;
  const timer = setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  try {
    const error = await executor.shell({command, block_until_ms: 10_000}, root, controller.signal).then(() => undefined, (error: Error) => error);
    expect(error?.message).toMatch(/^Error: Shell command was interrupted by the user after \d+ms before it completed\./);
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    clearTimeout(timer);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* It already exited. */ }
    await rm(root, {recursive: true, force: true});
  }
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

test("a routine handoff ends TERM-trapping background commands and records them as aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-shell-handoff-trap-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({agentDir: root, controlToken: "fixture"});
  const result = await executor.shell({command: "trap '' TERM; echo READY; sleep 30 & wait", block_until_ms: 0}, root, undefined, undefined, "scope", {automationRunId: "routine-run"});
  const { shellId, outputPath } = result.details as { shellId: string; outputPath: string };
  try {
    for (let i = 0; i < 200 && !(await readFile(outputPath, "utf8")).includes("READY"); i++) await Bun.sleep(10);
    expect(executor.stopAutomationShells(["routine-run"])).toBe(1);
    expect((await executor.awaitShell({shell_id: shellId, block_until_ms: 3000}, undefined, "scope")).details.status).toBe("completed");
    expect(await readFile(outputPath, "utf8")).toContain("\nstatus: aborted  \n");
  } finally {
    executor.stopBackgroundShells("scope");
    await executor.awaitShell({shell_id: shellId, block_until_ms: 5000}, undefined, "scope").catch(() => undefined);
    await rm(root, {recursive: true, force: true});
  }
});

test("stopping a subagent ends its background commands, TERM-trapping ones too, and leaves other agents' running", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-shell-subagent-stop-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({agentDir: root, controlToken: "fixture"});
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const started: Array<{ id: string; scope: string; path: string }> = [];
  const start = async (scope: string, command: string) => {
    const result = await executor.shell({command, block_until_ms: 0}, root, undefined, undefined, scope);
    const details = result.details as { shellId: string; outputPath: string };
    started.push({ id: details.shellId, scope, path: details.outputPath });
    return details;
  };
  const pidOf = async (path: string) => {
    for (let i = 0; i < 200; i++) {
      const match = /^PID=(\d+)$/m.exec(await readFile(path, "utf8"));
      if (match) return Number(match[1]);
      await Bun.sleep(10);
    }
    throw new Error("command did not start");
  };
  try {
    const plain = await start("child-bot", "echo PID=$$; exec sleep 30");
    const stubborn = await start("child-bot", "trap '' TERM; echo PID=$$; sleep 30 & wait");
    const other = await start("parent-bot", "echo PID=$$; exec sleep 30");
    const [plainPid, stubbornPid, otherPid] = await Promise.all([pidOf(plain.outputPath), pidOf(stubborn.outputPath), pidOf(other.outputPath)]);
    expect(executor.stopBackgroundShells("child-bot")).toBe(2);
    for (const pid of [plainPid, stubbornPid]) {
      for (let i = 0; i < 300 && alive(pid); i++) await Bun.sleep(10);
      expect(alive(pid)).toBe(false);
    }
    for (const shell of [plain, stubborn]) {
      expect((await executor.awaitShell({shell_id: shell.shellId, block_until_ms: 5000}, undefined, "child-bot")).details.status).toBe("completed");
      expect(await readFile(shell.outputPath, "utf8")).toContain("\nstatus: aborted  \n");
    }
    expect(alive(otherPid)).toBe(true);
    expect(executor.stopBackgroundShells("child-bot")).toBe(0);
  } finally {
    for (const shell of started) if (shell.scope === "parent-bot") executor.stopBackgroundShells("parent-bot");
    for (const shell of started) await executor.awaitShell({shell_id: shell.id, block_until_ms: 5000}, undefined, shell.scope).catch(() => undefined);
    await rm(root, {recursive: true, force: true});
  }
});
