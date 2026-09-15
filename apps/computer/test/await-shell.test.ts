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
  return runtime.customTools(active) as unknown as Array<{
    name: string;
    execute(
      id: string,
      args: Record<string, unknown>
    ): Promise<AgentToolResult<Record<string, unknown>>>;
  }>;
}

test("waits on split stdout/stderr beyond inline output and preserves completed metadata", async () => {
  const { executor, root } = await fixture();
  const shell = await executor.shell(
    {
      command:
        "printf '%0100001d' 0; printf '\nREA'; sleep 0.05; printf 'DY\n' >&2; sleep 0.2; exit 7",
      block_until_ms: 0,
    },
    root
  );
  const shell_id = shell.details.shellId as string;
  const ready = await executor.awaitShell({ shell_id, pattern: "^READY$", block_until_ms: 2_000 });
  expect(ready.details).toMatchObject({ status: "running", pattern_matched: true });
  expect(ready.details.output_length as number).toBeGreaterThan(100_000);
  const done = await executor.awaitShell({ shell_id, block_until_ms: 2_000 });
  expect(done.details).toMatchObject({
    status: "completed",
    exit_code: 7,
    output_path: shell.details.outputPath,
  });
  const again = await executor.awaitShell({ shell_id, block_until_ms: 0 });
  expect(again.details.elapsed_ms).toBe(done.details.elapsed_ms);
  expect(await readFile(done.details.output_path as string, "utf8")).toContain("exit_code: 7");
  expect(
    (await executor.awaitShell({ shell_id, pattern: "^exit_code:", block_until_ms: 0 })).details
      .pattern_matched
  ).toBe(false);
});

test("timeout and cancellation leave the background process available for another wait", async () => {
  const { executor, root } = await fixture();
  const shell = await executor.shell(
    { command: "sleep 0.3; printf survived", block_until_ms: 0 },
    root
  );
  const shell_id = shell.details.shellId as string;
  expect((await executor.awaitShell({ shell_id, block_until_ms: 5 })).details.status).toBe(
    "running"
  );
  const controller = new AbortController();
  const wait = executor.awaitShell({ shell_id, block_until_ms: 60_000 }, controller.signal);
  controller.abort(new Error("cancel wait"));
  await expect(wait).rejects.toThrow("cancel wait");
  const done = await executor.awaitShell({ shell_id, block_until_ms: 2_000 });
  expect(done.details).toMatchObject({ status: "completed", exit_code: 0 });
  expect(await readFile(done.details.output_path as string, "utf8")).toContain("survived");
});

test("exports and unsets persist across shell calls and runtime restarts while cwd resets", async () => {
  const { executor, root } = await fixture();
  await executor.shell({ command: "export PARITY_SHELL_VALUE='two words'; cd /tmp", block_until_ms: 1000 }, root, undefined, undefined, "bot");
  const next = await executor.shell({ command: 'printf "%s\\n" "$PARITY_SHELL_VALUE"; pwd', block_until_ms: 1000 }, root, undefined, undefined, "bot");
  expect(JSON.stringify(next.content)).toContain("two words");
  expect(JSON.stringify(next.content)).toContain(root);
  const restarted = new NativeToolExecutor({ agentDir: root, controlToken: "test" });
  const resumed = await restarted.shell({ command: 'printf "%s" "$PARITY_SHELL_VALUE"; unset PARITY_SHELL_VALUE', block_until_ms: 1000 }, root, undefined, undefined, "bot");
  expect(JSON.stringify(resumed.content)).toContain("two words");
  const cleared = await restarted.shell({ command: 'printf "%s" "${PARITY_SHELL_VALUE-unset}"', block_until_ms: 1000 }, root, undefined, undefined, "bot");
  expect(JSON.stringify(cleared.content)).toContain("unset");
});

test("discovers and invokes AwaitShell locally across turns with bot scope", async () => {
  const { root } = await fixture();
  const runtime = new RuntimeTools({} as ScreenBroker, "http://unused.invalid", "test", root, root);
  (runtime as any).processSecrets = async () => ({});
  const active = {
    runtimeProfile: "agent",
    botId: "bot-1",
    cwd: root,
    pluginNamespaces: [],
    discoveredDynamicTools: new Set<string>(),
  } as unknown as ActiveTurn;
  const custom = testTools(runtime, active);
  const shell = await custom
    .find((t) => t.name === "Shell")!
    .execute("shell", { command: "printf done", block_until_ms: 500 });
  const get = custom.find((t) => t.name === "GetDynamicTools")!;
  const call = custom.find((t) => t.name === "CallDynamicTool")!;
  const args = {
    namespace: "cursor",
    toolName: "AwaitShell",
    arguments: { shell_id: (shell.details as { shellId: string }).shellId, block_until_ms: 0 },
  };
  await expect(call.execute("undiscovered", args)).rejects.toThrow();
  const discovered = await get.execute("discover", { namespace: "cursor", toolName: "AwaitShell" });
  expect(JSON.stringify(discovered.content)).toContain("pattern");
  expect((await call.execute("wait", args)).details).toMatchObject({
    status: "completed",
    exit_code: 0,
  });
  const next = testTools(runtime, { ...active, discoveredDynamicTools: new Set() });
  await next
    .find((t) => t.name === "GetDynamicTools")!
    .execute("discover-next", { namespace: "cursor", toolName: "AwaitShell" });
  expect(
    (await next.find((t) => t.name === "CallDynamicTool")!.execute("wait-next", args)).details
  ).toMatchObject({ status: "completed" });
  const other = testTools(runtime, { ...active, botId: "bot-2" });
  await expect(
    other.find((t) => t.name === "CallDynamicTool")!.execute("wait-other", args)
  ).rejects.toThrow("Unknown or expired");
  const subagent = testTools(runtime, {
    ...active,
    runtimeProfile: "subagent",
    subagentType: "executor",
  });
  await expect(
    subagent
      .find((t) => t.name === "CallDynamicTool")!
      .execute("host-blocked", { ...args, arguments: { ...args.arguments, machineId: "host" } })
  ).rejects.toThrow("Subagents cannot target");
});

test("Read exposes supervisor terminal logs while retaining checks on adjacent files and symlink escapes", async () => {
  const { executor, root } = await fixture();
  const shell = await executor.shell(
    { command: "printf inspectable", block_until_ms: 1_000 },
    root
  );
  // Simulate the container's unprivileged runner being unable to traverse agentDir.
  (
    executor as unknown as { assertAgentReadable(path: string): Promise<void> }
  ).assertAgentReadable = async () => {
    throw new Error("agent-inaccessible");
  };
  const outputPath = shell.details.outputPath as string;
  expect(JSON.stringify((await executor.read({ path: outputPath }, root)).content)).toContain(
    "inspectable"
  );
  const privatePath = join(root, "auth.json");
  await writeFile(privatePath, "test fixture");
  await expect(executor.read({ path: privatePath }, root)).rejects.toThrow("agent-inaccessible");
  const escape = join(root, "terminals", `${crypto.randomUUID()}.log`);
  await symlink(privatePath, escape);
  await expect(executor.read({ path: escape }, root)).rejects.toThrow("agent-inaccessible");
});

test("external AwaitShell authenticates, uses the host wait endpoint, and parses metadata", async () => {
  const requests: unknown[] = [];
  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({
        status: "completed",
        shell_id: "host-job",
        exit_code: 0,
        output_path: "/host/job.log",
        output_length: 2,
        elapsed_ms: 3,
        waited_ms: 1,
        pattern_matched: true,
      });
    },
  });
  try {
    const { root } = await fixture();
    const executor = new NativeToolExecutor({
      agentDir: root,
      controlToken: "test",
      hostBridgeUrl: `http://127.0.0.1:${bridge.port}`,
    });
    const input = {
      shell_id: "host-job",
      machineId: "machine-1",
      block_until_ms: 7_140_000,
      pattern: "ok",
    };
    expect((await executor.externalAwaitShell(input)).details).toMatchObject({
      status: "completed",
      pattern_matched: true,
    });
    expect(requests).toEqual([
      { path: "/v1/await-shell", authorization: "Bearer test", body: input },
    ]);
  } finally {
    bridge.stop(true);
  }
});
