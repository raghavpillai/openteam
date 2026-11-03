import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
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
    expect(middle.content[0]).toEqual({ type: "text", text: "... 1 line not shown ...\n     2|beta\n... 2 lines not shown ..." });
    const last = await executor.read({ path, offset: -2, limit: 1 }, root);
    expect(last.content[0]).toEqual({ type: "text", text: "... 2 lines not shown ...\n     3|gamma\n... 1 line not shown ..." });
  });

  test("Read failures use the reference error texts and are failed calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-read-errors-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "data.raw"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "bundle.tar.gz"), "not really");
    await writeFile(join(root, "six.txt"), "1\n2\n3\n4\n5\n6");
    const failure = (path: string, offset?: number) =>
      executor.read({ path, offset }, root).then(() => "resolved", (error: Error) => error.message);
    expect(await failure(join(root, "folder"))).toBe(`Error: Path is a directory, not a file: ${join(root, "folder")}`);
    expect(await failure(join(root, "data.raw"))).toBe(`Error: File content is binary data, not text: ${join(root, "data.raw")}`);
    expect(await failure(join(root, "bundle.tar.gz"))).toBe("Error: Cannot read binary files of type gz");
    expect(await failure(join(root, "six.txt"), 50)).toBe("Error: Offset 50 is beyond file length (6 lines)");
    expect(await failure("   ")).toBe("Error: path is empty or only whitespace");
    expect(await failure(join(root, "missing.txt"))).toBe("Error: File not found");
  });

  test("Read recognizes images by content, labels them, and refuses undecodable ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-read-image-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4////fwAJ+wP92PZgeAAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(root, "chart"), png);
    const image = await executor.read({ path: join(root, "chart") }, root);
    expect(image.content[0]).toEqual({ type: "text", text: `Read image file: ${await realpath(join(root, "chart"))}` });
    expect(image.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    await writeFile(join(root, "broken.png"), png.subarray(0, 20));
    await expect(executor.read({ path: join(root, "broken.png") }, root)).rejects.toThrow(
      /^Error: File is not a valid image: its data could not be decoded \(.+\)\. A truncated or hand-copied file does this; write it again from the original bytes with code\.: /
    );
  });

  test("Read renders a Jupyter notebook as cells and outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-read-notebook-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const path = join(root, "analysis.ipynb");
    await writeFile(path, JSON.stringify({
      cells: [
        { cell_type: "code", source: ["import math\n", "print(math.pi)"], outputs: [{ output_type: "stream", text: ["3.14\n"] }, { output_type: "execute_result", data: { "text/plain": "'done'" } }] },
        { cell_type: "code", source: "1/0", outputs: [{ output_type: "error", traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"] }] },
        { cell_type: "markdown", source: "# Notes", outputs: [] },
      ],
    }));
    expect((await executor.read({ path }, root)).content[0]).toEqual({
      type: "text",
      text: "\nCell 0:\n```\nimport math\nprint(math.pi)```\n\nCell 0 output:\n```\n3.14\n'done'```\n\n\nCell 1:\n```\n1/0```\n\nCell 1 output:\n```\nZeroDivisionError: division by zero```\n\n\nCell 2:\n```\n# Notes```\n\n",
    });
    await writeFile(path, JSON.stringify({ cells: [] }));
    expect((await executor.read({ path }, root)).content[0]).toEqual({ type: "text", text: "Notebook is empty (0 cells)" });
  });

  test("Read streams large text files and keeps only the requested lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-read-large-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const path = join(root, "server.log");
    const line = "x".repeat(99);
    // 9 MiB of 100-byte lines: past the streaming threshold.
    const count = 94_372;
    await writeFile(path, `${Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(6, "0")}${line.slice(6)}`).join("\n")}\nLAST`);
    const tail = await executor.read({ path, offset: -2 }, root);
    expect(tail.content[0]).toEqual({ type: "text", text: `... ${count - 1} lines not shown ...\n ${String(count).padStart(5)}|${String(count).padStart(6, "0")}${line.slice(6)}\n ${String(count + 1).padStart(5)}|LAST` });
    expect(tail.details).toMatchObject({ totalLines: count + 1, exceededLimit: false });
    const middle = await executor.read({ path, offset: 1000, limit: 2 }, root);
    expect(middle.content[0]).toEqual({ type: "text", text: `... 999 lines not shown ...\n  1000|001000${line.slice(6)}\n  1001|001001${line.slice(6)}\n... ${count + 1 - 1001} lines not shown ...` });
    await expect(executor.read({ path }, root)).rejects.toThrow(`Requested content exceeds maximum allowed characters (100000 characters). The file is ${count * 100 + 4} bytes.`);
    await expect(executor.read({ path, offset: count + 5 }, root)).rejects.toThrow(`Error: Offset ${count + 5} is beyond file length (${count + 1} lines)`);
    await writeFile(join(root, "large.dat"), Buffer.alloc(9 * 1024 * 1024));
    await expect(executor.read({ path: join(root, "large.dat") }, root)).rejects.toThrow("Error: File content is binary data, not text");
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

  shellTest("each Shell command's processes carry its own shell id, which is never saved as shell state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-shell-id-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const run = async () => {
      const result = await executor.shell({ command: "echo \"id=$OPENTEAM_SHELL_ID\"; export OPENTEAM_SHELL_ID=stale", working_directory: root }, root, undefined, undefined, "bot-a");
      const log = await readFile((result.details as { outputPath: string }).outputPath, "utf8");
      return { id: /id=(\d+)/.exec(log)?.[1], logName: (result.details as { outputPath: string }).outputPath.split("/").at(-1) };
    };
    const first = await run();
    const second = await run();
    expect(first.logName).toBe(`${first.id}.log`);
    expect(second.logName).toBe(`${second.id}.log`);
    expect(second.id).not.toBe(first.id);
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

  shellTest("a background completion carries the call's description, else its command", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-title-"));
    const completions: Array<{ title?: string; exitCode: number | null }> = [];
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token", onShellComplete: async (job) => { completions.push(job); } });
    await executor.shell({ command: "exit 2", description: "Run the suite", block_until_ms: 0 }, root);
    await executor.shell({ command: "true", block_until_ms: 0 }, root);
    for (let attempt = 0; attempt < 50 && completions.length < 2; attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(completions.map(({ title, exitCode }) => ({ title, exitCode })).sort((a, b) => a.title!.localeCompare(b.title!))).toEqual([
      { title: "Run the suite", exitCode: 2 },
      { title: "true", exitCode: 0 },
    ]);
  });

  shellTest("a background command is stopped once it reaches the hard time limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-expire-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token", shellHardTimeoutMs: 300 });
    const started = await executor.shell({ command: "sleep 30", block_until_ms: 0 }, root);
    const done = await executor.awaitShell({ shell_id: String(started.details.shellId), block_until_ms: 5_000 });
    expect(done.details).toMatchObject({ status: "failed", error: expect.stringContaining("The command was stopped after running for") });
    expect(await readFile(String(started.details.outputPath), "utf8")).toContain("status: aborted  \n");
  });

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
