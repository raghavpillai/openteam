import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-shell-"));
  roots.push(root);
  await chmod(root, 0o755);
  return { root, executor: new NativeToolExecutor({ agentDir: root, controlToken: "fixture" }) };
};

test("shell restores scoped cwd/env after errors, honors overrides and refuses a deleted cwd", async () => {
  const root=await mkdtemp(join(tmpdir(),"edge-shell-"));
  try {
    await mkdir(join(root,"sub"));
    const ex=new NativeToolExecutor({agentDir:root,controlToken:"fixture"});
    const run=(command:string,working_directory?:string,scope="a")=>ex.shell({command,working_directory},root,undefined,undefined,scope);
    await run(`cd '${root}/sub' && export EDGE_VALUE=kept && (exit 7)`);
    expect(await ex.shellWorkingDirectory({},root,"a")).toBe(join(root,"sub"));
    expect(JSON.stringify(await run('pwd; printf "%s" "$EDGE_VALUE"'))).toContain(`${root}/sub\\nkept`);
    expect(await ex.shellWorkingDirectory({},root,"b")).toBe(root);
    await run("pwd",root);
    expect(await ex.shellWorkingDirectory({},root,"a")).toBe(root);
    await run(`cd '${root}/sub'`);
    await rm(join(root,"sub"),{recursive:true});
    // A deleted directory stops the command instead of running it somewhere else.
    const refused = await run("touch should-not-exist");
    expect(refused.details.exitCode).toBe(1);
    expect((refused.content[0] as {text:string}).text).toContain(`The shell's working directory no longer exists: ${root}/sub. The command did not run. Re-run it with working_directory set to an existing directory.`);
    expect((await run("touch should-not-exist")).details.exitCode).toBe(1);
    expect(await stat(join(root,"should-not-exist")).catch(()=>null)).toBeNull();
    expect((await run("printf recovered",root)).details.exitCode).toBe(0);
    expect(await ex.shellWorkingDirectory({},root,"a")).toBe(root);
    expect((await run("printf recovered")).details.exitCode).toBe(0);
    await expect(run("pwd",join(root,"missing"))).rejects.toThrow(`Error: Command failed to spawn: working directory does not exist: ${root}/missing; the command did not run`);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("background completion preserves newer foreground cwd and exported/unset variables", async () => {
  const root=await mkdtemp(join(tmpdir(),"shell-overlap-"));
  try {
    await mkdir(join(root,"older")); await mkdir(join(root,"newer"));
    const ex=new NativeToolExecutor({agentDir:root,controlToken:"fixture"});
    const run=(command:string,block_until_ms?:number)=>ex.shell({command,block_until_ms},root,undefined,undefined,"one");
    await run(`cd '${root}/older'; export STATEQA_VALUE=initial STATEQA_REMOVE=remove_me`);
    const bg=await run(`while ! test -f '${root}/release'; do sleep 0.05; done; sleep 0.1; printf background`,0);
    await run(`cd '${root}/newer'; export STATEQA_VALUE=foreground; unset STATEQA_REMOVE; touch '${root}/release'`);
    await ex.awaitShell({shell_id:String(bg.details.shellId),block_until_ms:5000},undefined,"one");
    const result=await run('printf "%s|%s|%s" "$PWD" "$STATEQA_VALUE" "${STATEQA_REMOVE-unset}"');
    expect(JSON.stringify(result)).toContain(`${root}/newer|foreground|unset`);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("named secrets enter the real shell without appearing in results, logs or persisted environment", async () => {
  const { root, executor } = await workspace();
  const secret = "fixture-secrét-密-private";
  const result = await executor.shell(
    { command: 'test -n "$FIXTURE_PROCESS_SECRET" && printf "%s" "$FIXTURE_PROCESS_SECRET"', block_until_ms: 5000, working_directory: root },
    root, undefined, undefined, "fixture-bot",
    { secretEnvironment: { FIXTURE_PROCESS_SECRET: secret }, secrets: [secret] }
  );
  expect((result.content[0] as any).text).toContain("```\n[REDACTED]\n```");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(await readFile(String(result.details.outputPath), "utf8")).not.toContain(secret);
  const inspect = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else expect((await readFile(file)).includes(Buffer.from(secret))).toBe(false);
    }
  };
  await inspect(root);
});

for (const command of ["trap '' TERM; echo READY; sleep 3; echo UNEXPECTED", "(trap '' TERM; sleep 3) & wait; echo UNEXPECTED"]) test(`foreground cancellation stops descendants: ${command}`, async () => {
  const { root, executor } = await workspace();
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    // A stopped command is an interruption error with the output it printed, never a completion.
    const error = await executor.shell({command, block_until_ms: 5000}, root, controller.signal).then(() => undefined, (error: Error) => error);
    expect(error?.message).toMatch(/^Error: Shell command was interrupted by the user after \d+ms before it completed\./);
    expect(error?.message).not.toContain("UNEXPECTED");
    if (command.startsWith("trap")) expect(error?.message).toContain("Output collected before interruption:\n\n```\nREADY\n\n```");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { clearTimeout(timer); }
});

test("a stopped command returns promptly even when a descendant left the process group holding its output", async () => {
  const { root, executor } = await workspace();
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
  }
});

test("a routine handoff stops the background commands its runs started, and only those", async () => {
  const { root, executor } = await workspace();
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
  }
});

test("stopping a subagent ends its background commands, TERM-trapping ones too, and leaves other agents' running", async () => {
  const { root, executor } = await workspace();
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
  }
});

test("retiring a room stops its background commands without stopping members' other conversations", async () => {
  const { root, executor } = await workspace();
  const room = crypto.randomUUID();
  const otherRoom = crypto.randomUUID();
  const bots = [crypto.randomUUID(), crypto.randomUUID()];
  const jobs: Array<{ id: string; botId: string; channelId: string }> = [];
  const status = async (job: typeof jobs[number], wait = 0) =>
    (await executor.awaitShell({ shell_id: job.id, block_until_ms: wait }, undefined, job.botId)).details.status;
  try {
    for (const botId of bots) {
      for (const channelId of [room, otherRoom]) {
        const result = await executor.shell({ command: "sleep 20", block_until_ms: 0 }, root, undefined, undefined, botId, { channelId });
        jobs.push({ id: String(result.details?.shellId), botId, channelId });
      }
    }
    expect(executor.stopBackgroundShells(room)).toBe(2);
    for (const job of jobs) {
      expect(await status(job, job.channelId === room ? 3000 : 0)).toBe(job.channelId === room ? "completed" : "running");
    }
  } finally {
    for (const botId of bots) executor.stopBackgroundShells(botId);
    await Promise.all(jobs.map((job) => status(job, 5000).catch(() => {})));
  }
}, 15_000);
