import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeToolExecutor, sanitizedShellEnvironment } from "../src/native-tool-executor";
import { agentFileIO } from "../src/agent-file-io";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

const temporary = () => tempDir("openteam-read-");

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
  test("Read exposes supervisor terminal logs while retaining checks on adjacent files and symlink escapes", async () => {
    const root = await temporary();
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const shell = await executor.shell({ command: "printf inspectable", block_until_ms: 1_000 }, root);
    // Simulate the container's unprivileged runner being unable to traverse agentDir.
    (executor as any).assertAgentReadable = async () => { throw new Error("agent-inaccessible"); };
    expect(JSON.stringify((await executor.read({ path: shell.details.outputPath as string }, root)).content)).toContain("inspectable");
    const privatePath = join(root, "auth.json");
    await writeFile(privatePath, "test fixture");
    await expect(executor.read({ path: privatePath }, root)).rejects.toThrow("agent-inaccessible");
    const escape = join(root, "terminals", "4242424242.log");
    await symlink(privatePath, escape);
    await expect(executor.read({ path: escape }, root)).rejects.toThrow("agent-inaccessible");
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
   const root=await realpath(await temporary());
    const data=root+'/data';await mkdir(data);
    const secret=data+'/settings.json';await writeFile(secret,'DUMMY-PRIVATE-CANARY');
    const target=root+'/ordinary.txt';await writeFile(target,'public');
    const ex=new NativeToolExecutor({agentDir:root+'/runtime',controlToken:'fixture',agentDataCanonicalRoot:data});
    await expect(ex.read({path:secret},root)).rejects.toThrow('protected agent-data');
    const check=(ex as any).assertAgentReadable.bind(ex);
    (ex as any).assertAgentReadable=async(path:string)=>{await check(path);if(path===target){await rm(target);await symlink(secret,target)}};
    await expect(ex.read({path:target},root)).rejects.toThrow('protected agent-data');
  });

  test('Read allows an ordinary atomic replacement and recovers after missing old name',async()=>{
   const root=await temporary();
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
  });

  test('Privileged terminal exception rejects an opened descriptor redirected outside logs',async()=>{
   const root=await temporary();
    const data=root+'/data';await mkdir(data);await mkdir(root+'/terminals');
    const secret=data+'/settings.json';await writeFile(secret,'DUMMY-PRIVATE-CANARY');
    const target=root+'/terminals/123456.log';await writeFile(target,'log');
    const ex=new NativeToolExecutor({agentDir:root,controlToken:'fixture',agentDataCanonicalRoot:data});
    expect(JSON.stringify(await ex.read({path:target},root))).toContain('log');
    const check=(ex as any).assertProtectedReadPath.bind(ex);let swapped=false;
    (ex as any).assertProtectedReadPath=async(path:string)=>{await check(path);if(!swapped){swapped=true;await rm(target);await symlink(secret,target)}};
    await expect(ex.read({path:target},root)).rejects.toThrow('protected agent-data');
  });

  test('Read rejects a regular file replaced by a FIFO without waiting for a writer',async()=>{
   const root=await temporary();
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
  },3000);
});
