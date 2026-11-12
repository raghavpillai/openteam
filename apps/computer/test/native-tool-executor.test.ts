import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeToolExecutor,
  sanitizedShellEnvironment,
} from "../src/native-tool-executor";
import { agentFileIO } from "../src/agent-file-io";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-read-"));
  roots.push(root);
  return root;
};

describe("native computer tools", () => {
  test("Read returns numbered lines with positive and negative paging", async () => {
    const root = await temporary();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });

    const middle = await executor.read({ path, offset: 2, limit: 1 }, root);
    expect(middle.content[0]).toEqual({ type: "text", text: "... 1 line not shown ...\n     2|beta\n... 2 lines not shown ..." });
    const last = await executor.read({ path, offset: -2, limit: 1 }, root);
    expect(last.content[0]).toEqual({ type: "text", text: "... 2 lines not shown ...\n     3|gamma\n... 1 line not shown ..." });
  });

  test("Read renders a Jupyter notebook as cells and outputs", async () => {
    const root = await temporary();
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
    const root = await temporary();
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
    const root = await temporary();
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
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token", agentDataCanonicalRoot: sandRoot });

    expect((await executor.read({ path: join(agentRoot, "profile.json") }, root)).content[0]).toEqual({ type: "text", text: '     1|{"name":"Probe"}\n     2|' });
    for (const path of [join(sandRoot, "plugin-skills", "cache.json"), join(agentRoot, "deliverables", "store.db"), join(sandRoot, "custom-folder", "public.txt")]) {
      expect(JSON.stringify((await executor.read({ path }, root)).content)).toMatch(/harmless|skills/);
    }
    await expect(executor.read({ path: join(sandRoot, "settings.json") }, root)).rejects.toThrow("protected agent-data path");
    await expect(executor.read({ path: join(agentRoot, "store.db") }, root)).rejects.toThrow("Read does not expose live agent SQLite files");
    await expect(executor.read({ path: join(sandRoot, ".openteam", "marker.json") }, root)).rejects.toThrow("Read is not allowed for protected agent-data path");
  });

  test("Shell environment removes gateway credentials and startup injection hooks", () => {
    const secrets = ["OPENTEAM_CONTROL_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GENERIC_PROVIDER_PASSWORD", "AWS_ACCESS_KEY_ID", "OPENTEAM_PI_AGENT_DIR", "DATABASE_URL", "BASH_ENV", "ENV"];
    const environment = sanitizedShellEnvironment({ HOME: "/home/box", SAFE_VALUE: "kept", ...Object.fromEntries(secrets.map((key) => [key, "secret"])) }, "/workspace");
    expect(environment).toEqual({ HOME: "/home/box", SAFE_VALUE: "kept", PWD: "/workspace" });
  });

  const shellTest = process.env.CI === "true" && process.platform === "darwin" ? test.skip : test;

  shellTest("Shell keeps the head and tail of long output and spills large output to a file", async () => {
    const root = await temporary();
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
    const root = await temporary();
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
    const root = await temporary();
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
    const root = await temporary();
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
    const root = await temporary();
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
    const root = await temporary();
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token", shellHardTimeoutMs: 300 });
    const started = await executor.shell({ command: "sleep 30", block_until_ms: 0 }, root);
    const done = await executor.awaitShell({ shell_id: String(started.details.shellId), block_until_ms: 5_000 });
    expect(done.details).toMatchObject({ status: "failed", error: expect.stringContaining("The command was stopped after running for") });
    expect(await readFile(String(started.details.outputPath), "utf8")).toContain("status: aborted  \n");
  });

  test("host-targeted Read, Shell and AwaitShell authenticate to the physical-host bridge", async () => {
    const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({ path, authorization: request.headers.get("authorization"), body: await request.json() });
        return path === "/v1/read"
          ? Response.json({ kind: "text", path: "/host/notes.txt", text: "1: host-read-ok", lines: 1 })
          : Response.json({ shell_id: "host-shell-1", status: "completed", exit_code: 0, output: "host-shell-ok", output_path: "/host/terminals/host-shell-1.log", elapsed_ms: 3, ...(path === "/v1/await-shell" ? { output_length: 13, waited_ms: 1, pattern_matched: true } : {}) });
      },
    });
    try {
      const executor = new NativeToolExecutor({ agentDir: await temporary(), controlToken: "bridge-token", hostBridgeUrl: `http://127.0.0.1:${bridge.port}` });
      expect((await executor.externalRead({ path: "/host/notes.txt" })).content[0]).toEqual({ type: "text", text: "1: host-read-ok" });
      // Host results use the same layout as box results.
      expect((await executor.externalShell({ command: "printf host-shell-ok" })).content[0]).toEqual({
        type: "text",
        text: "Exit code: 0\n\nCommand output:\n\n```\nhost-shell-ok\n```\n\nCommand completed in 3 ms.\n\nShell state (cwd, env vars) persists for subsequent calls.",
      });
      const wait = { shell_id: "host-shell-1", machineId: "machine-1", block_until_ms: 780_000, pattern: "ok" };
      expect((await executor.externalAwaitShell(wait)).details).toMatchObject({ status: "completed", pattern_matched: true });
      expect(requests).toEqual([
        { path: "/v1/read", authorization: "Bearer bridge-token", body: { path: "/host/notes.txt" } },
        { path: "/v1/shell", authorization: "Bearer bridge-token", body: { command: "printf host-shell-ok" } },
        { path: "/v1/await-shell", authorization: "Bearer bridge-token", body: wait },
      ]);
    } finally {
      bridge.stop(true);
    }
  });
});

describe("Read edge cases", () => {
  test.skipIf(!Bun.which("pdftotext"))("extracts native PDFs, including a large one known by its header, and leaves bytes intact", async () => {
    const root = await temporary();
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const file = join(root, "fixture.pdf");
    const original = await readFile(new URL("./fixtures/input-parity/fixture.pdf", import.meta.url));
    await writeFile(file, original);
    expect(JSON.stringify((await executor.read({ path: file }, root)).content)).toContain("PDF_");
    expect(await readFile(file)).toEqual(original);
    const large = join(root, "1089646.data");
    const pdf = await readFile(new URL("./fixtures/input-parity/three-pages.pdf", import.meta.url));
    // Past the 8 MiB streaming threshold; PDF readers ignore bytes after the end marker.
    await writeFile(large, Buffer.concat([pdf, Buffer.alloc(9 * 1024 * 1024, 0x0a)]));
    expect(((await executor.read({ path: large }, root)).content[0] as { text: string }).text).toContain("-- 1 of 3 --");
  });

  test('Read rejects a file swapped into protected state after its initial readability check',async()=>{
   const root=await realpath(await mkdtemp('/tmp/read-race-'));
   try {
    const data=root+'/data';await mkdir(data);
    const secret=data+'/settings.json';await writeFile(secret,'DUMMY-PRIVATE-CANARY');
    const target=root+'/ordinary.txt';await writeFile(target,'public');
    const ex=new NativeToolExecutor({agentDir:root+'/runtime',controlToken:'fixture',agentDataCanonicalRoot:data});
    await expect(ex.read({path:secret},root)).rejects.toThrow('protected agent-data');
    const check=(ex as any).assertAgentReadable.bind(ex);
    (ex as any).assertAgentReadable=async(path:string)=>{await check(path);if(path===target){await rm(target);await symlink(secret,target)}};
    await expect(ex.read({path:target},root)).rejects.toThrow('protected agent-data');
   }finally{await rm(root,{recursive:true,force:true})}
  });

  test('Read allows an ordinary atomic replacement and recovers after missing old name',async()=>{
   const root=await mkdtemp('/tmp/read-replace-');
   try {
    const target=root+'/draft.txt';await writeFile(target,'OLD');
    const replacement=root+'/new.txt';await writeFile(replacement,'café 日本語\r\nNEW');
    const ex=new NativeToolExecutor({agentDir:root+'/runtime',controlToken:'fixture'});
    const check=(ex as any).assertAgentReadable.bind(ex);let replaced=false;
    (ex as any).assertAgentReadable=async(path:string)=>{await check(path);if(!replaced){await rename(replacement,target);replaced=true}};
    const result=await ex.read({path:target},root);
    expect(JSON.stringify(result)).toContain('café 日本語');
    expect(result.details.fileSize).toBe(Buffer.byteLength('café 日本語\r\nNEW'));
    const renamed=root+'/résumé 日本語 #1.txt';await rename(target,renamed);
    await expect(ex.read({path:target},root)).rejects.toThrow('Error: File not found');
    expect(JSON.stringify(await ex.read({path:renamed},root))).toContain('NEW');
   }finally{await rm(root,{recursive:true,force:true})}
  });

  test('Privileged terminal exception rejects an opened descriptor redirected outside logs',async()=>{
   const root=await mkdtemp('/tmp/read-log-');
   try {
    const data=root+'/data';await mkdir(data);await mkdir(root+'/terminals');
    const secret=data+'/settings.json';await writeFile(secret,'DUMMY-PRIVATE-CANARY');
    const target=root+'/terminals/123456.log';await writeFile(target,'log');
    const ex=new NativeToolExecutor({agentDir:root,controlToken:'fixture',agentDataCanonicalRoot:data});
    expect(JSON.stringify(await ex.read({path:target},root))).toContain('log');
    const check=(ex as any).assertProtectedReadPath.bind(ex);let swapped=false;
    (ex as any).assertProtectedReadPath=async(path:string)=>{await check(path);if(!swapped){swapped=true;await rm(target);await symlink(secret,target)}};
    await expect(ex.read({path:target},root)).rejects.toThrow('protected agent-data');
   }finally{await rm(root,{recursive:true,force:true})}
  });

  test('Read rejects a regular file replaced by a FIFO without waiting for a writer',async()=>{
   const root=await mkdtemp('/tmp/read-fifo-');
   try {
    for(const terminal of [false,true]) {
     const runtime=root+(terminal?'/terminal-case':'/ordinary-case');await mkdir(runtime+'/terminals',{recursive:true});
     const target=runtime+(terminal?'/terminals/123456.log':'/ordinary.txt');await writeFile(target,'before');
     const ex=new NativeToolExecutor({agentDir:runtime,controlToken:'fixture'});
     const method=terminal?'assertProtectedReadPath':'assertAgentReadable';
     const check=(ex as any)[method].bind(ex);let swapped=false;
     (ex as any)[method]=async(path:string)=>{await check(path);if(!swapped){swapped=true;await rm(target);execFileSync('mkfifo',[target])}};
     await expect(ex.read({path:target},root)).rejects.toThrow(/regular file|neither a file nor a directory/);
     await expect(agentFileIO('read',target)).rejects.toThrow('regular file');
    }
   }finally{await rm(root,{recursive:true,force:true})}
  },3000);
});
