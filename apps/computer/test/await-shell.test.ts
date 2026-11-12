import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
import type { ScreenBroker } from "../src/screen-broker";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-await-"));
  roots.push(root);
  return { root, executor: new NativeToolExecutor({ agentDir: root, controlToken: "test" }) };
}

// RuntimeTools' native implementations do not consume Pi's UI context arguments.
function testTools(runtime: RuntimeTools, active: ActiveTurn) {
  return runtime.customTools(active) as unknown as Array<{ name: string; execute(id: string, args: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> }>;
}

test("waits on split stdout/stderr beyond inline output and preserves completed metadata", async () => {
  const { executor, root } = await fixture();
  const shell = await executor.shell({ command: "printf '%0100001d' 0; printf '\nREA'; sleep 0.05; printf 'DY\n' >&2; sleep 0.2; exit 7", block_until_ms: 0 }, root);
  const shell_id = shell.details.shellId as string;
  const ready = await executor.awaitShell({ shell_id, pattern: "^READY$", block_until_ms: 2_000 });
  expect(ready.details).toMatchObject({ status: "running", pattern_matched: true });
  expect(ready.details.output_length as number).toBeGreaterThan(100_000);
  const done = await executor.awaitShell({ shell_id, block_until_ms: 2_000 });
  expect(done.details).toMatchObject({ status: "completed", exit_code: 7, output_path: shell.details.outputPath });
  const again = await executor.awaitShell({ shell_id, block_until_ms: 0 });
  expect(again.details.elapsed_ms).toBe(done.details.elapsed_ms);
  expect(await readFile(done.details.output_path as string, "utf8")).toContain("exit_code: 7");
  expect((await executor.awaitShell({ shell_id, pattern: "^exit_code:", block_until_ms: 0 })).details.pattern_matched).toBe(false);
});

test("timeout and cancellation leave the background process available for another wait", async () => {
  const { executor, root } = await fixture();
  const shell = await executor.shell({ command: "sleep 0.3; printf survived", block_until_ms: 0 }, root);
  const shell_id = shell.details.shellId as string;
  expect((await executor.awaitShell({ shell_id, block_until_ms: 5 })).details.status).toBe("running");
  const controller = new AbortController();
  const wait = executor.awaitShell({ shell_id, block_until_ms: 60_000 }, controller.signal);
  controller.abort(new Error("cancel wait"));
  await expect(wait).rejects.toThrow("cancel wait");
  const done = await executor.awaitShell({ shell_id, block_until_ms: 2_000 });
  expect(done.details).toMatchObject({ status: "completed", exit_code: 0 });
  expect(await readFile(done.details.output_path as string, "utf8")).toContain("survived");
});

test("exports, unsets and cwd persist across shell calls and runtime restarts", async () => {
  const { executor, root } = await fixture();
  await executor.shell({ command: "export PARITY_SHELL_VALUE='two words'; cd /tmp", block_until_ms: 1000 }, root, undefined, undefined, "bot");
  const next = await executor.shell({ command: 'printf "%s\\n" "$PARITY_SHELL_VALUE"; pwd', block_until_ms: 1000 }, root, undefined, undefined, "bot");
  expect(JSON.stringify(next.content)).toContain("two words");
  expect(JSON.stringify(next.content)).toContain("/tmp");
  const restarted = new NativeToolExecutor({ agentDir: root, controlToken: "test" });
  const resumed = await restarted.shell({ command: 'printf "%s" "$PARITY_SHELL_VALUE"; unset PARITY_SHELL_VALUE', block_until_ms: 1000 }, root, undefined, undefined, "bot");
  expect(JSON.stringify(resumed.content)).toContain("two words");
  const cleared = await restarted.shell({ command: 'printf "%s" "${PARITY_SHELL_VALUE-unset}"', block_until_ms: 1000 }, root, undefined, undefined, "bot");
  expect(JSON.stringify(cleared.content)).toContain("unset");
});

test("discovers and invokes AwaitShell locally with bot scope", async () => {
  const { root } = await fixture();
  const runtime = new RuntimeTools({} as ScreenBroker, "http://unused.invalid", "test", root, root);
  (runtime as any).processSecrets = async () => ({});
  const active = { runtimeProfile: "agent", botId: "bot-1", cwd: root, pluginNamespaces: [] } as unknown as ActiveTurn;
  const tool = (turn: ActiveTurn, name: string) => testTools(runtime, turn).find((t) => t.name === name)!;
  const shell = await tool(active, "Shell").execute("shell", { command: "printf done", block_until_ms: 500 });
  const args = { namespace: "cursor", toolName: "AwaitShell", arguments: { shell_id: (shell.details as { shellId: string }).shellId, block_until_ms: 0 } };
  // As in the reference, a call needs no prior schema lookup.
  expect((await tool(active, "CallDynamicTool").execute("undiscovered", args)).details).toMatchObject({ status: "completed", exit_code: 0 });
  const discovered = await tool(active, "GetDynamicTools").execute("discover", { namespace: "cursor", toolName: "AwaitShell" });
  expect(JSON.stringify(discovered.content)).toContain("pattern");
  await expect(tool({ ...active, botId: "bot-2" }, "CallDynamicTool").execute("wait-other", args)).rejects.toThrow(
    `Error awaiting task: No shell found for id ${args.arguments.shell_id}`
  );
  const subagent = { ...active, runtimeProfile: "subagent", subagentType: "executor" } as ActiveTurn;
  // Executors have AwaitShell directly, so the cursor form runs that tool natively.
  expect((await tool(subagent, "CallDynamicTool").execute("via-namespace", args)).details).toMatchObject({ status: "completed" });
  await expect(tool(subagent, "AwaitShell").execute("host-blocked", { ...args.arguments, machineId: "host" })).rejects.toThrow("Subagents cannot target");
});

test("Read exposes supervisor terminal logs while retaining checks on adjacent files and symlink escapes", async () => {
  const { executor, root } = await fixture();
  const shell = await executor.shell({ command: "printf inspectable", block_until_ms: 1_000 }, root);
  // Simulate the container's unprivileged runner being unable to traverse agentDir.
  (executor as any).assertAgentReadable = async () => {
    throw new Error("agent-inaccessible");
  };
  expect(JSON.stringify((await executor.read({ path: shell.details.outputPath as string }, root)).content)).toContain("inspectable");
  const privatePath = join(root, "auth.json");
  await writeFile(privatePath, "test fixture");
  await expect(executor.read({ path: privatePath }, root)).rejects.toThrow("agent-inaccessible");
  const escape = join(root, "terminals", "4242424242.log");
  await symlink(privatePath, escape);
  await expect(executor.read({ path: escape }, root)).rejects.toThrow("agent-inaccessible");
});

test("a stop kills a running foreground Shell and reports it as interrupted", async () => {
  const {root}=await fixture();
  const runtime=new RuntimeTools({} as ScreenBroker,"http://unused.invalid","test",root,root);
  (runtime as any).processSecrets=async()=>({});
  const stopped={runId:"stop-shell",runtimeProfile:"agent",botId:"bot-stop-shell",cwd:root,pluginNamespaces:[]} as unknown as ActiveTurn;
  const controller=new AbortController();
  const running=(runtime as unknown as {executeScopedTool(active:ActiveTurn,callId:string,tool:string,args:unknown,signal?:AbortSignal):Promise<unknown>})
    .executeScopedTool(stopped,"stop","Shell",{command:"echo partial; sleep 5"},controller.signal);
  const stop=setTimeout(()=>{stopped.endTurnRequested=true;controller.abort();},300);
  try {await expect(running).rejects.toThrow(/^Error: Shell command was interrupted by the user after \d+ms before it completed\.\n\nOutput collected before interruption:\n\n```\npartial\n\n```$/);}
  finally{clearTimeout(stop);}
});

test("each Shell or AwaitShell call waits at most 13 minutes, or 58 for a computerUse worker", async () => {
  const { root } = await fixture();
  const screens = { commandEnvironment: async () => ({ PATH: process.env.PATH }) } as unknown as ScreenBroker;
  const runtime = new RuntimeTools(screens, "http://unused.invalid", "test", root, root);
  (runtime as any).processSecrets = async () => ({});
  const turn = (subagentType: string | null) =>
    ({ runId: `cap-${subagentType}`, runtimeProfile: subagentType ? "subagent" : "agent", subagentType, botId: "bot-cap", cwd: root, pluginNamespaces: [] }) as unknown as ActiveTurn;
  for (const [subagentType, capMs, minutes] of [["executor", 780_000, 13], ["computerUse", 3_480_000, 58]] as const) {
    const tools = testTools(runtime, turn(subagentType));
    const shell = tools.find((t) => t.name === "Shell")!, wait = tools.find((t) => t.name === "AwaitShell")!;
    await expect(shell.execute("too-long", { command: "true", block_until_ms: capMs + 1 })).rejects.toThrow(
      `block_until_ms must be at most ${capMs}ms (${minutes} minutes)`
    );
    const started = await shell.execute("start", { command: "printf done", block_until_ms: 0 });
    const shell_id = (started.details as { shellId: string }).shellId;
    await expect(wait.execute("too-long", { shell_id, block_until_ms: capMs + 1 })).rejects.toThrow(
      `block_until_ms must be at most ${capMs} (${minutes} minutes)`
    );
    // A wait at the cap returns as soon as the command finishes.
    expect((await wait.execute("at-cap", { shell_id, block_until_ms: capMs })).details).toMatchObject({ status: "completed" });
  }
  // The parent agent has the same 13-minute cap, through discovery.
  const main = turn(null), tools = testTools(runtime, main);
  await tools.find((t) => t.name === "GetDynamicTools")!.execute("discover", { namespace: "cursor", toolName: "AwaitShell" });
  await expect(
    tools.find((t) => t.name === "CallDynamicTool")!.execute("too-long", {
      namespace: "cursor", toolName: "AwaitShell", arguments: { block_until_ms: 780_001 },
    })
  ).rejects.toThrow("block_until_ms must be at most 780000 (13 minutes)");
});

test("a Read issued beside the Shell call that creates its file waits for it and retries once", async () => {
  const {root}=await fixture();
  const runtime=new RuntimeTools({} as ScreenBroker,"http://unused.invalid","test",root,root);
  (runtime as any).processSecrets=async()=>({});
  const active={runId:"same-step",runtimeProfile:"agent",botId:"bot-same-step",cwd:root,pluginNamespaces:[]} as unknown as ActiveTurn;
  const tools=testTools(runtime,active);
  const shell=tools.find(t=>t.name==="Shell")!.execute("make",{command:"sleep 0.3; printf made > chart.txt"});
  const read=tools.find(t=>t.name==="Read")!.execute("read",{path:"chart.txt"});
  expect((await read).content[0]).toEqual({type:"text",text:"     1|made"});
  await shell;
  // Without an earlier writer in the step, a missing file fails at once.
  await expect(tools.find(t=>t.name==="Read")!.execute("again",{path:"absent.txt"})).rejects.toThrow("Error: File not found");
});
