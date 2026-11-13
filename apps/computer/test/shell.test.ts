// Shell and AwaitShell: native executor behaviour and the RuntimeTools surface over it.
import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { NativeToolExecutor } from "../src/native-tool-executor";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

const workspace = async (options: Partial<ConstructorParameters<typeof NativeToolExecutor>[0]> = {}) => {
  const root = await tempDir("openteam-shell-");
  await chmod(root, 0o755);
  return { root, executor: new NativeToolExecutor({ agentDir: root, controlToken: "fixture", ...options }) };
};
const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const outputPath = (result: { details: unknown }) => (result.details as { outputPath: string }).outputPath;
const shellTest = process.env.CI === "true" && process.platform === "darwin" ? test.skip : test;

/** RuntimeTools over `root`, with native tools invoked without Pi's UI context arguments. */
const runtimeTools = (root: string, screens: unknown = {}) => {
  const runtime = new RuntimeTools(screens as never, "http://unused.invalid", "test", root, root);
  (runtime as any).processSecrets = async () => ({});
  const tools = (turn: Record<string, unknown>) => runtime.customTools({ runtimeProfile: "agent", cwd: root, pluginNamespaces: [], ...turn } as unknown as ActiveTurn) as unknown as
    Array<{ name: string; execute(id: string, args: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> }>;
  const tool = (turn: Record<string, unknown>, name: string) => tools(turn).find((t) => t.name === name)!;
  return { runtime, tools, tool };
};

test("shell restores scoped cwd/env after errors, honors overrides, survives restarts and refuses a deleted cwd", async () => {
  const { root, executor: ex } = await workspace();
  await mkdir(join(root, "sub"));
  const run = (command: string, working_directory?: string, scope = "a", executor = ex) => executor.shell({ command, working_directory }, root, undefined, undefined, scope);
  await run(`cd '${root}/sub' && export EDGE_VALUE=kept && (exit 7)`);
  expect(await ex.shellWorkingDirectory({}, root, "a")).toBe(join(root, "sub"));
  expect(JSON.stringify(await run('pwd; printf "%s" "$EDGE_VALUE"'))).toContain(`${root}/sub\\nkept`);
  expect(await ex.shellWorkingDirectory({}, root, "b")).toBe(root);
  // Exports and unsets persist across a runtime restart.
  const restarted = new NativeToolExecutor({ agentDir: root, controlToken: "fixture" });
  expect(JSON.stringify(await run('printf "%s" "$EDGE_VALUE"; unset EDGE_VALUE', undefined, "a", restarted))).toContain("kept");
  expect(JSON.stringify(await run('printf "%s" "${EDGE_VALUE-unset}"', undefined, "a", restarted))).toContain("unset");
  await run("pwd", root);
  expect(await ex.shellWorkingDirectory({}, root, "a")).toBe(root);
  await run(`cd '${root}/sub'`);
  await rm(join(root, "sub"), { recursive: true });
  // A deleted directory stops the command instead of running it somewhere else.
  const refused = await run("touch should-not-exist");
  expect(refused.details.exitCode).toBe(1);
  expect(text(refused)).toContain(`The shell's working directory no longer exists: ${root}/sub. The command did not run. Re-run it with working_directory set to an existing directory.`);
  expect((await run("touch should-not-exist")).details.exitCode).toBe(1);
  expect(await stat(join(root, "should-not-exist")).catch(() => null)).toBeNull();
  expect((await run("printf recovered", root)).details.exitCode).toBe(0);
  expect(await ex.shellWorkingDirectory({}, root, "a")).toBe(root);
  expect((await run("printf recovered")).details.exitCode).toBe(0);
  await expect(run("pwd", join(root, "missing"))).rejects.toThrow(`Error: Command failed to spawn: working directory does not exist: ${root}/missing; the command did not run`);
});

test("background completion preserves newer foreground cwd and exported/unset variables", async () => {
  const { root, executor: ex } = await workspace();
  await mkdir(join(root, "older")); await mkdir(join(root, "newer"));
  const run = (command: string, block_until_ms?: number) => ex.shell({ command, block_until_ms }, root, undefined, undefined, "one");
  await run(`cd '${root}/older'; export STATEQA_VALUE=initial STATEQA_REMOVE=remove_me`);
  const bg = await run(`while ! test -f '${root}/release'; do sleep 0.05; done; sleep 0.1; printf background`, 0);
  await run(`cd '${root}/newer'; export STATEQA_VALUE=foreground; unset STATEQA_REMOVE; touch '${root}/release'`);
  await ex.awaitShell({ shell_id: String(bg.details.shellId), block_until_ms: 5000 }, undefined, "one");
  expect(JSON.stringify(await run('printf "%s|%s|%s" "$PWD" "$STATEQA_VALUE" "${STATEQA_REMOVE-unset}"'))).toContain(`${root}/newer|foreground|unset`);
});

test("named secrets enter the real shell without appearing in results, logs or persisted environment", async () => {
  const { root, executor } = await workspace();
  const secret = "fixture-secrét-密-private";
  const result = await executor.shell(
    { command: 'test -n "$FIXTURE_PROCESS_SECRET" && printf "%s" "$FIXTURE_PROCESS_SECRET"', block_until_ms: 5000, working_directory: root },
    root, undefined, undefined, "fixture-bot",
    { secretEnvironment: { FIXTURE_PROCESS_SECRET: secret }, secrets: [secret] }
  );
  expect(text(result)).toContain("```\n[REDACTED]\n```");
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

shellTest("Shell keeps the head and tail of long output and spills large output to a file", async () => {
  const { root, executor } = await workspace();
  const medium = await executor.shell({ command: "printf 'START'; head -c 30000 /dev/zero | tr '\\0' m; printf 'END'", block_until_ms: 5_000 }, root);
  expect(text(medium)).toStartWith(`Exit code: 0\n\nCommand output (truncated to 20000 characters):\n\n\`\`\`\nSTART${"m".repeat(9_995)}\n\n... (output truncated) ...\n\n${"m".repeat(9_997)}END\n\`\`\``);
  expect(medium.details).not.toHaveProperty("spillPath");
  const large = await executor.shell({ command: "seq 1 50000", block_until_ms: 5_000 }, root);
  const spillPath = (large.details as { spillPath: string }).spillPath;
  expect(spillPath).toStartWith(join(root, ".openteam", "agent-tools"));
  expect(text(large)).toMatch(/^Exit code: 0\n\nCommand output has been written to: \S+\.txt \(282\.1 KB, 50000 lines\)\n\nCommand completed in \d+ ms\.\n\nShell state \(cwd, env vars\) persists for subsequent calls\.$/);
  const spilled = await readFile(spillPath, "utf8");
  expect(spilled.startsWith("1\n2\n")).toBe(true);
  expect(spilled.endsWith("49999\n50000\n")).toBe(true);
});

shellTest("each Shell command's processes carry its own shell id, which is never saved as shell state", async () => {
  const { root, executor } = await workspace();
  const run = async () => {
    const result = await executor.shell({ command: "echo \"id=$OPENTEAM_SHELL_ID\"; export OPENTEAM_SHELL_ID=stale", working_directory: root }, root, undefined, undefined, "bot-a");
    return { id: /id=(\d+)/.exec(await readFile(outputPath(result), "utf8"))?.[1], logName: outputPath(result).split("/").at(-1) };
  };
  const first = await run();
  const second = await run();
  expect(first.logName).toBe(`${first.id}.log`);
  expect(second.logName).toBe(`${second.id}.log`);
  expect(second.id).not.toBe(first.id);
});

shellTest("Shell reports the final directory, signal kills and the terminal header", async () => {
  const { root, executor } = await workspace();
  await mkdir(join(root, "sub"));
  const moved = await executor.shell({ command: "cd sub", working_directory: root, description: "Enter sub" }, root);
  expect(text(moved)).toEndWith(`Shell state (cwd, env vars) persists for subsequent calls. Current directory: ${join(root, "sub")}`);
  expect(await readFile(outputPath(moved), "utf8")).toMatch(
    new RegExp(`^---\\npid: \\d+\\ncwd: "${root}"\\ncommand: "cd sub"\\ntitle: "Enter sub"\\nstatus: succeeded\\nstarted_at: \\S+\\nrunning_for_ms: \\d+ *\\n---\\n\\n---\\nexit_code: 0\\nelapsed_ms: \\d+\\nended_at: \\S+\\n---\\n$`)
  );
  const killed = await executor.shell({ command: "echo before; kill -9 $$" }, root);
  expect(text(killed)).toBe(
    `Exit code: -1\n\nCommand output:\n\n\`\`\`\nbefore\n\n\`\`\`\n\nCommand completed in ${(killed.details as { elapsedMs: number }).elapsedMs} ms.\n\nShell state (cwd, env vars) persists for subsequent calls.\n\nThis command was killed by signal 9 (SIGKILL), possibly because the machine ran out of memory. If nothing else killed it, use less memory: run fewer jobs in parallel, process data in smaller batches, or stop background processes you no longer need.`
  );
});

shellTest("a command that outlives block_until_ms keeps its early output and a live header", async () => {
  const { root, executor } = await workspace();
  const result = await executor.shell({ command: "echo starting; sleep 6; echo done", block_until_ms: 300 }, root);
  const { shellId } = result.details as { shellId: string };
  const path = outputPath(result);
  expect(text(result)).toMatch(
    new RegExp(`^The command did not complete in 300ms and was sent to the background\\.\\nShell ID: ${shellId}\\nPID: \\d+\\nThe output is being written to ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Don't mention Shell ID to the user\\.\\n\\nOutput collected before backgrounding:\\n\\n\`\`\`\\nstarting\\n\\n\`\`\`$`)
  );
  const header = async () => (await readFile(path, "utf8")).split("---\n")[1]!;
  expect(await header()).toContain("status: running  \n");
  await Bun.sleep(5_400);
  // The running time is rewritten in place every 5 seconds without moving the output.
  expect(Number((await header()).match(/running_for_ms: (\d+)/)?.[1])).toBeGreaterThanOrEqual(5_000);
  expect((await readFile(path, "utf8")).split("---\n")[2]).toBe("starting\n");
  expect((await executor.awaitShell({ shell_id: shellId, block_until_ms: 3_000 })).details).toMatchObject({ status: "completed", exit_code: 0 });
  expect(await header()).toContain("status: succeeded\n");
}, 15_000);

shellTest("a background completion carries the call's description, else its command", async () => {
  const completions: Array<{ title?: string; exitCode: number | null }> = [];
  const { root, executor } = await workspace({ onShellComplete: async (job) => { completions.push(job); } });
  await executor.shell({ command: "exit 2", description: "Run the suite", block_until_ms: 0 }, root);
  await executor.shell({ command: "true", block_until_ms: 0 }, root);
  for (let attempt = 0; attempt < 50 && completions.length < 2; attempt++) await Bun.sleep(100);
  expect(completions.map(({ title, exitCode }) => ({ title, exitCode })).sort((a, b) => a.title!.localeCompare(b.title!))).toEqual([
    { title: "Run the suite", exitCode: 2 },
    { title: "true", exitCode: 0 },
  ]);
});

shellTest("a background command is stopped once it reaches the hard time limit", async () => {
  const { root, executor } = await workspace({ shellHardTimeoutMs: 300 });
  const started = await executor.shell({ command: "sleep 30", block_until_ms: 0 }, root);
  const done = await executor.awaitShell({ shell_id: String(started.details.shellId), block_until_ms: 5_000 });
  expect(done.details).toMatchObject({ status: "failed", error: expect.stringContaining("The command was stopped after running for") });
  expect(await readFile(String(started.details.outputPath), "utf8")).toContain("status: aborted  \n");
});

test("AwaitShell waits on split stdout/stderr beyond inline output and preserves completed metadata", async () => {
  const { executor, root } = await workspace();
  const shell = await executor.shell({ command: "printf '%0100001d' 0; printf '\nREA'; sleep 0.05; printf 'DY\n' >&2; sleep 0.2; exit 7", block_until_ms: 0 }, root);
  const shell_id = shell.details.shellId as string;
  const ready = await executor.awaitShell({ shell_id, pattern: "^READY$", block_until_ms: 2_000 });
  expect(ready.details).toMatchObject({ status: "running", pattern_matched: true });
  expect(ready.details.output_length as number).toBeGreaterThan(100_000);
  const done = await executor.awaitShell({ shell_id, block_until_ms: 2_000 });
  expect(done.details).toMatchObject({ status: "completed", exit_code: 7, output_path: shell.details.outputPath });
  expect((await executor.awaitShell({ shell_id, block_until_ms: 0 })).details.elapsed_ms).toBe(done.details.elapsed_ms);
  expect(await readFile(done.details.output_path as string, "utf8")).toContain("exit_code: 7");
  expect((await executor.awaitShell({ shell_id, pattern: "^exit_code:", block_until_ms: 0 })).details.pattern_matched).toBe(false);
});

test("AwaitShell timeout and cancellation leave the background process available for another wait", async () => {
  const { executor, root } = await workspace();
  const shell_id = (await executor.shell({ command: "sleep 0.3; printf survived", block_until_ms: 0 }, root)).details.shellId as string;
  expect((await executor.awaitShell({ shell_id, block_until_ms: 5 })).details.status).toBe("running");
  const controller = new AbortController();
  const wait = executor.awaitShell({ shell_id, block_until_ms: 60_000 }, controller.signal);
  controller.abort(new Error("cancel wait"));
  await expect(wait).rejects.toThrow("cancel wait");
  const done = await executor.awaitShell({ shell_id, block_until_ms: 2_000 });
  expect(done.details).toMatchObject({ status: "completed", exit_code: 0 });
  expect(await readFile(done.details.output_path as string, "utf8")).toContain("survived");
});

for (const command of ["trap '' TERM; echo READY; sleep 3; echo UNEXPECTED", "(trap '' TERM; sleep 3) & wait; echo UNEXPECTED"]) test(`foreground cancellation stops descendants: ${command}`, async () => {
  const { root, executor } = await workspace();
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    // A stopped command is an interruption error with the output it printed, never a completion.
    const error = await executor.shell({ command, block_until_ms: 5000 }, root, controller.signal).then(() => undefined, (error: Error) => error);
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
    const error = await executor.shell({ command, block_until_ms: 10_000 }, root, controller.signal).then(() => undefined, (error: Error) => error);
    expect(error?.message).toMatch(/^Error: Shell command was interrupted by the user after \d+ms before it completed\./);
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    clearTimeout(timer);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* It already exited. */ }
  }
});

test("routine handoffs and retired rooms stop only the background commands they own", async () => {
  const { root, executor } = await workspace();
  const room = crypto.randomUUID();
  const jobs: Array<{ id: string; scope: string; owner: string }> = [];
  const status = async (job: typeof jobs[number], wait = 0) => (await executor.awaitShell({ shell_id: job.id, block_until_ms: wait }, undefined, job.scope)).details.status;
  try {
    for (const [scope, owner, options] of [
      ["bot-a", "routine-run", { automationRunId: "routine-run" }], ["bot-a", "routine-continuation", { automationRunId: "routine-continuation" }],
      ["bot-a", "another-routine", { automationRunId: "another-routine" }], ["bot-a", "parent", {}],
      ["bot-a", room, { channelId: room }], ["bot-b", room, { channelId: room }], ["bot-b", "other-room", { channelId: crypto.randomUUID() }],
    ] as const) {
      const result = await executor.shell({ command: "sleep 20", block_until_ms: 0 }, root, undefined, undefined, scope, options);
      jobs.push({ id: String(result.details?.shellId), scope, owner });
    }
    expect(executor.stopAutomationShells(["routine-run", "routine-continuation"])).toBe(2);
    expect(executor.stopBackgroundShells(room)).toBe(2);
    for (const job of jobs) {
      const stopped = ["routine-run", "routine-continuation", room].includes(job.owner);
      expect(await status(job, stopped ? 3000 : 0)).toBe(stopped ? "completed" : "running");
    }
  } finally {
    for (const scope of ["bot-a", "bot-b"]) executor.stopBackgroundShells(scope);
    await Promise.all(jobs.map((job) => status(job, 5000).catch(() => {})));
  }
}, 15_000);

test("stopping a subagent ends its background commands, TERM-trapping ones too, and leaves other agents' running", async () => {
  const { root, executor } = await workspace();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const started: Array<{ id: string; scope: string }> = [];
  const start = async (scope: string, command: string) => {
    const details = (await executor.shell({ command, block_until_ms: 0 }, root, undefined, undefined, scope)).details as { shellId: string; outputPath: string };
    started.push({ id: details.shellId, scope });
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
      expect((await executor.awaitShell({ shell_id: shell.shellId, block_until_ms: 5000 }, undefined, "child-bot")).details.status).toBe("completed");
      expect(await readFile(shell.outputPath, "utf8")).toContain("\nstatus: aborted  \n");
    }
    expect(alive(otherPid)).toBe(true);
    expect(executor.stopBackgroundShells("child-bot")).toBe(0);
  } finally {
    executor.stopBackgroundShells("parent-bot");
    for (const shell of started) await executor.awaitShell({ shell_id: shell.id, block_until_ms: 5000 }, undefined, shell.scope).catch(() => undefined);
  }
});

test("discovers and invokes AwaitShell locally with bot scope", async () => {
  const { root } = await workspace();
  const { tool } = runtimeTools(root);
  const active = { botId: "bot-1" };
  const shell = await tool(active, "Shell").execute("shell", { command: "printf done", block_until_ms: 500 });
  const args = { namespace: "cursor", toolName: "AwaitShell", arguments: { shell_id: (shell.details as { shellId: string }).shellId, block_until_ms: 0 } };
  // As in the reference, a call needs no prior schema lookup.
  expect((await tool(active, "CallDynamicTool").execute("undiscovered", args)).details).toMatchObject({ status: "completed", exit_code: 0 });
  expect(JSON.stringify((await tool(active, "GetDynamicTools").execute("discover", { namespace: "cursor", toolName: "AwaitShell" })).content)).toContain("pattern");
  await expect(tool({ botId: "bot-2" }, "CallDynamicTool").execute("wait-other", args)).rejects.toThrow(`Error awaiting task: No shell found for id ${args.arguments.shell_id}`);
  const subagent = { ...active, runtimeProfile: "subagent", subagentType: "executor" };
  // Executors have AwaitShell directly, so the cursor form runs that tool natively.
  expect((await tool(subagent, "CallDynamicTool").execute("via-namespace", args)).details).toMatchObject({ status: "completed" });
  await expect(tool(subagent, "AwaitShell").execute("host-blocked", { ...args.arguments, machineId: "host" })).rejects.toThrow("Subagents cannot target");
});

test("a stop kills a running foreground Shell and reports it as interrupted", async () => {
  const { root } = await workspace();
  const { runtime } = runtimeTools(root);
  const stopped = { runId: "stop-shell", runtimeProfile: "agent", botId: "bot-stop-shell", cwd: root, pluginNamespaces: [] } as unknown as ActiveTurn;
  const controller = new AbortController();
  const running = (runtime as any).executeScopedTool(stopped, "stop", "Shell", { command: "echo partial; sleep 5" }, controller.signal);
  const stop = setTimeout(() => { stopped.endTurnRequested = true; controller.abort(); }, 300);
  try { await expect(running).rejects.toThrow(/^Error: Shell command was interrupted by the user after \d+ms before it completed\.\n\nOutput collected before interruption:\n\n```\npartial\n\n```$/); }
  finally { clearTimeout(stop); }
});

test("each Shell or AwaitShell call waits at most 13 minutes, or 58 for a computerUse worker", async () => {
  const { root } = await workspace();
  const { tools } = runtimeTools(root, { commandEnvironment: async () => ({ PATH: process.env.PATH }) });
  const turn = (subagentType: string | null) => ({ runId: `cap-${subagentType}`, runtimeProfile: subagentType ? "subagent" : "agent", subagentType, botId: "bot-cap" });
  for (const [subagentType, capMs, minutes] of [["executor", 780_000, 13], ["computerUse", 3_480_000, 58]] as const) {
    const available = tools(turn(subagentType));
    const shell = available.find((t) => t.name === "Shell")!, wait = available.find((t) => t.name === "AwaitShell")!;
    await expect(shell.execute("too-long", { command: "true", block_until_ms: capMs + 1 })).rejects.toThrow(`block_until_ms must be at most ${capMs}ms (${minutes} minutes)`);
    const shell_id = ((await shell.execute("start", { command: "printf done", block_until_ms: 0 })).details as { shellId: string }).shellId;
    await expect(wait.execute("too-long", { shell_id, block_until_ms: capMs + 1 })).rejects.toThrow(`block_until_ms must be at most ${capMs} (${minutes} minutes)`);
    // A wait at the cap returns as soon as the command finishes.
    expect((await wait.execute("at-cap", { shell_id, block_until_ms: capMs })).details).toMatchObject({ status: "completed" });
  }
  // The parent agent has the same 13-minute cap, through discovery.
  const main = tools(turn(null));
  await main.find((t) => t.name === "GetDynamicTools")!.execute("discover", { namespace: "cursor", toolName: "AwaitShell" });
  await expect(main.find((t) => t.name === "CallDynamicTool")!.execute("too-long", { namespace: "cursor", toolName: "AwaitShell", arguments: { block_until_ms: 780_001 } }))
    .rejects.toThrow("block_until_ms must be at most 780000 (13 minutes)");
});

test("a Read issued beside the Shell call that creates its file waits for it and retries once", async () => {
  const { root } = await workspace();
  const available = runtimeTools(root).tools({ runId: "same-step", botId: "bot-same-step" });
  const shell = available.find((t) => t.name === "Shell")!.execute("make", { command: "sleep 0.3; printf made > chart.txt" });
  const read = available.find((t) => t.name === "Read")!.execute("read", { path: "chart.txt" });
  expect((await read).content[0]).toEqual({ type: "text", text: "     1|made" });
  await shell;
  // Without an earlier writer in the step, a missing file fails at once.
  await expect(available.find((t) => t.name === "Read")!.execute("again", { path: "absent.txt" })).rejects.toThrow("Error: File not found");
});
