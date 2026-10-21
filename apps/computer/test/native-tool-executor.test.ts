import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeToolExecutor,
  sanitizedShellEnvironment,
} from "../src/native-tool-executor";

describe("native computer tools", () => {
  test("Read returns numbered lines with positive and negative paging", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-read-"));
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });

    const middle = await executor.read({ path, offset: 2, limit: 1 }, root);
    expect(middle.content[0]).toEqual({ type: "text", text: "... 1 lines not shown ...\n     2|beta\n... 2 lines not shown ..." });
    const last = await executor.read({ path, offset: -2, limit: 1 }, root);
    expect(last.content[0]).toEqual({ type: "text", text: "... 2 lines not shown ...\n     3|gamma\n... 1 lines not shown ..." });
  });

  test("Read exposes supported agent files while fencing stores and host metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-protected-read-"));
    const sandRoot = join(root, "sand-data");
    const agentRoot = join(sandRoot, "agents", "probe");
    await mkdir(join(sandRoot, ".openteam"), { recursive: true });
    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(sandRoot, "plugin-skills"), { recursive: true });
    await writeFile(join(sandRoot, "plugin-skills", "cache.json"), '{"skills":[]}\n');
    await writeFile(join(agentRoot, "profile.json"), '{"name":"Probe"}\n');
    await writeFile(join(agentRoot, "store.db"), "not a readable projection");
    await mkdir(join(agentRoot, "deliverables"));
    await mkdir(join(sandRoot, "custom-folder"));
    await writeFile(join(agentRoot, "deliverables", "store.db"), "harmless nested file");
    await writeFile(join(sandRoot, "custom-folder", "public.txt"), "harmless public file");
    await writeFile(join(sandRoot, "settings.json"), "private fixture");
    await writeFile(join(sandRoot, ".openteam", "marker.json"), "{}\n");
    const executor = new NativeToolExecutor({
      agentDir: root,
      controlToken: "test-token",
      agentDataCanonicalRoot: sandRoot,
    });

    expect(
      (await executor.read({ path: join(agentRoot, "profile.json") }, root)).content[0]
    ).toEqual({ type: "text", text: '     1|{"name":"Probe"}\n     2|' });
    expect(
      (await executor.read({ path: join(sandRoot, "plugin-skills", "cache.json") }, root)).content[0]
    ).toEqual({ type: "text", text: '     1|{"skills":[]}\n     2|' });
    for (const path of [join(agentRoot, "deliverables", "store.db"), join(sandRoot, "custom-folder", "public.txt")]) {
      expect(JSON.stringify((await executor.read({path},root)).content)).toContain("harmless");
    }
    await expect(executor.read({path:join(sandRoot,"settings.json")},root)).rejects.toThrow("protected agent-data path");
    await expect(executor.read({ path: join(agentRoot, "store.db") }, root)).rejects.toThrow(
      "Read does not expose live agent SQLite files"
    );
    await expect(
      executor.read({ path: join(sandRoot, ".openteam", "marker.json") }, root)
    ).rejects.toThrow("Read is not allowed for protected agent-data path");
  });

  test("Shell environment removes gateway credentials and startup injection hooks", () => {
    const environment = sanitizedShellEnvironment(
      {
        HOME: "/home/box",
        OPENTEAM_CONTROL_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        GENERIC_PROVIDER_PASSWORD: "secret",
        AWS_ACCESS_KEY_ID: "secret",
        OPENTEAM_PI_AGENT_DIR: "/home/box/.pi/agent",
        DATABASE_URL: "postgres://secret",
        BASH_ENV: "/tmp/inject",
        ENV: "/tmp/inject",
        SAFE_VALUE: "kept",
      },
      "/workspace"
    );
    expect(environment).toEqual({ HOME: "/home/box", SAFE_VALUE: "kept", PWD: "/workspace" });
  });

  const shellTest = process.env.CI === "true" && process.platform === "darwin" ? test.skip : test;

  shellTest("Shell executes foreground commands and records a terminal log", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-shell-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.shell(
      { command: "printf 'native-shell-ok'", working_directory: root, block_until_ms: 5_000 },
      root
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain("```\nnative-shell-ok\n```");
    const outputPath = (result.details as { outputPath: string }).outputPath;
    expect(await readFile(outputPath, "utf8")).toContain("exit_code: 0");
  });

  shellTest("Shell keeps the head and tail of long output and spills large output to a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-large-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const medium = await executor.shell(
      { command: "printf 'START'; head -c 30000 /dev/zero | tr '\\0' m; printf 'END'", block_until_ms: 5_000 },
      root
    );
    const text = (medium.content[0] as { text: string }).text;
    expect(text).toStartWith(`Exit code: 0\n\nCommand output (truncated to 20000 characters):\n\n\`\`\`\nSTART${"m".repeat(9_995)}\n\n... (output truncated) ...\n\n${"m".repeat(9_997)}END\n\`\`\``);
    expect(medium.details).not.toHaveProperty("spillPath");

    const large = await executor.shell({ command: "seq 1 50000", block_until_ms: 5_000 }, root);
    const spillPath = (large.details as { spillPath: string }).spillPath;
    expect(spillPath).toStartWith(join(root, ".openteam", "agent-tools"));
    expect((large.content[0] as { text: string }).text).toMatch(
      /^Exit code: 0\n\nCommand output has been written to: \S+\.txt \(282\.1 KB, 50000 lines\)\n\nCommand completed in \d+ ms\.\n\nShell state \(cwd, env vars\) persists for subsequent calls\.$/
    );
    const spilled = await readFile(spillPath, "utf8");
    expect(spilled.startsWith("1\n2\n")).toBe(true);
    expect(spilled.endsWith("49999\n50000\n")).toBe(true);
  });

  shellTest("Shell reports the final directory, signal kills and the terminal header", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-cwd-"));
    await mkdir(join(root, "sub"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const moved = await executor.shell({ command: "cd sub", working_directory: root, description: "Enter sub" }, root);
    expect((moved.content[0] as { text: string }).text).toEndWith(
      `Shell state (cwd, env vars) persists for subsequent calls. Current directory: ${join(root, "sub")}`
    );
    const log = await readFile((moved.details as { outputPath: string }).outputPath, "utf8");
    expect(log).toMatch(
      new RegExp(`^---\\npid: \\d+\\ncwd: "${root}"\\ncommand: "cd sub"\\ntitle: "Enter sub"\\nstatus: succeeded\\nstarted_at: \\S+\\nrunning_for_ms: \\d+ *\\n---\\n\\n---\\nexit_code: 0\\nelapsed_ms: \\d+\\nended_at: \\S+\\n---\\n$`)
    );
    const killed = await executor.shell({ command: "echo before; kill -9 $$" }, root);
    expect((killed.content[0] as { text: string }).text).toBe(
      `Exit code: -1\n\nCommand output:\n\n\`\`\`\nbefore\n\n\`\`\`\n\nCommand completed in ${(killed.details as { elapsedMs: number }).elapsedMs} ms.\n\nShell state (cwd, env vars) persists for subsequent calls.\n\nThis command was killed by signal 9 (SIGKILL), possibly because the machine ran out of memory. If nothing else killed it, use less memory: run fewer jobs in parallel, process data in smaller batches, or stop background processes you no longer need.`
    );
  });

  shellTest("a command that outlives block_until_ms keeps its early output and a live header", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-timeout-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.shell({ command: "echo starting; sleep 6; echo done", block_until_ms: 300 }, root);
    const { shellId, outputPath } = result.details as { shellId: string; outputPath: string };
    expect((result.content[0] as { text: string }).text).toMatch(
      new RegExp(`^The command did not complete in 300ms and was sent to the background\\.\\nShell ID: ${shellId}\\nPID: \\d+\\nThe output is being written to ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Don't mention Shell ID to the user\\.\\n\\nOutput collected before backgrounding:\\n\\n\`\`\`\\nstarting\\n\\n\`\`\`$`)
    );
    const header = async () => (await readFile(outputPath, "utf8")).split("---\n")[1]!;
    expect(await header()).toContain("status: running  \n");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_400));
    // The running time is rewritten in place every 5 seconds without moving the output.
    expect(Number((await header()).match(/running_for_ms: (\d+)/)?.[1])).toBeGreaterThanOrEqual(5_000);
    expect((await readFile(outputPath, "utf8")).split("---\n")[2]).toBe("starting\n");
    const done = await executor.awaitShell({ shell_id: shellId, block_until_ms: 3_000 });
    expect(done.details).toMatchObject({ status: "completed", exit_code: 0 });
    expect(await header()).toContain("status: succeeded\n");
  }, 15_000);

  test("Shell backgrounds long commands and exposes their log path", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-background-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.shell(
      { command: "sleep 0.1; printf done", working_directory: root, block_until_ms: 0 },
      root
    );
    expect((result.details as { status: string }).status).toBe("running");
    expect((result.details as { outputPath: string }).outputPath).toContain("terminals");
  });

  test("host-targeted Read and Shell authenticate to the physical-host bridge", async () => {
    const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        if (new URL(request.url).pathname === "/v1/read") {
          return Response.json({
            kind: "text",
            path: "/host/notes.txt",
            text: "1: host-read-ok",
            lines: 1,
          });
        }
        return Response.json({
          shell_id: "host-shell-1",
          status: "completed",
          exit_code: 0,
          output: "host-shell-ok",
          output_path: "/host/terminals/host-shell-1.log",
          elapsed_ms: 3,
        });
      },
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "openteam-native-external-"));
      const executor = new NativeToolExecutor({
        agentDir: root,
        controlToken: "bridge-token",
        hostBridgeUrl: `http://127.0.0.1:${bridge.port}`,
      });
      const read = await executor.externalRead({ path: "/host/notes.txt" });
      expect(read.content[0]).toEqual({ type: "text", text: "1: host-read-ok" });
      const shell = await executor.externalShell({ command: "printf host-shell-ok" });
      // Host results use the same layout as box results.
      expect(shell.content[0]).toEqual({
        type: "text",
        text: "Exit code: 0\n\nCommand output:\n\n```\nhost-shell-ok\n```\n\nCommand completed in 3 ms.\n\nShell state (cwd, env vars) persists for subsequent calls.",
      });
      expect(requests).toEqual([
        {
          path: "/v1/read",
          authorization: "Bearer bridge-token",
          body: { path: "/host/notes.txt" },
        },
        {
          path: "/v1/shell",
          authorization: "Bearer bridge-token",
          body: { command: "printf host-shell-ok" },
        },
      ]);
    } finally {
      bridge.stop(true);
    }
  });

});
