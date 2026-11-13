import { readLimitNotice } from "@openteam/contracts/read-output";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeHostJob,
  executeShell,
  hostShellCapacitySnapshot,
  MAX_INLINE_BYTES,
  numberText,
  ShellCapacity,
  terminateHostChildren,
} from "../../src/main/host/jobs";

const shellQuote = (value: string) =>
  process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
};

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const createLongProcessTree = async (root: string, name: string) => {
  const marker = join(root, `${name}-pids.txt`);
  const script = join(root, `${name}.cjs`);
  await writeFile(
    script,
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const marker = process.argv[2];",
      'const descendant = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "writeFileSync(marker, `${process.pid}\\n${descendant.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8"
  );
  return {
    marker,
    command: `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(marker)}`,
  };
};

const readPids = async (marker: string) => {
  await waitFor(() => readFile(marker).then(() => true, () => false));
  return (await readFile(marker, "utf8")).trim().split("\n").map(Number);
};
const allExited = (pids: number[]) => waitFor(() => pids.every((pid) => !processAlive(pid)));
const tempRoot = async (name: string, run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), `openteam-shell-${name}-`));
  try {
    await run(root);
  } finally {
    await terminateHostChildren();
    await rm(root, { recursive: true, force: true });
  }
};

afterEach(async () => {
  await terminateHostChildren();
});

test("host AwaitShell cancellation stops the wait without terminating the command", () =>
  tempRoot("await-cancel", async (root) => {
    const shell = await executeShell({ command: `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(() => {}, 200)")}`, block_until_ms: 0, working_directory: root }, root);
    const payload = { kind: "await-shell" as const, input: { shell_id: shell.shell_id, block_until_ms: 60_000 }, terminalDir: root };
    const controller = new AbortController();
    const pending = executeHostJob(payload, controller.signal);
    controller.abort(new Error("stop waiting"));
    await expect(pending).rejects.toThrow("stop waiting");
    expect(await executeHostJob(payload)).toMatchObject({ status: "completed", exit_code: 0 });
  }));

describe("host file text projection", () => {
  test("preserves line numbering, offsets, limits, CRLF, and trailing lines", () => {
    expect(numberText("alpha\r\nbeta\ngamma\n", undefined, undefined)).toEqual({
      text: "     1|alpha\n     2|beta\n     3|gamma\n     4|",
      lines: 4,
    });
    expect(numberText("alpha\nbeta\ngamma", 2, 1)).toEqual({ text: "... 1 line not shown ...\n     2|beta\n... 1 line not shown ...", lines: 1 });
    expect(numberText("alpha\nbeta\ngamma", -2, undefined)).toEqual({
      text: "... 1 line not shown ...\n     2|beta\n     3|gamma",
      lines: 2,
    });
    expect(() => numberText("alpha", 99, undefined)).toThrow("Offset 99 is beyond file length (1 lines)");
  });

  test("bounds output without allocating a numbered copy of every input line", () => {
    const input = "x\n".repeat(5_000_000);
    const startedAt = performance.now();
    const result = numberText(input, undefined, undefined);
    const elapsedMs = performance.now() - startedAt;

    expect(result.lines).toBe(5_000_001);
    expect(result.text.length).toBeLessThanOrEqual(MAX_INLINE_BYTES + "\n… truncated".length);
    expect(result.text).toBe(readLimitNotice(input.length));
    // This is recorded as a regression signal, not a hard wall-clock assertion for CI hosts.
    console.info(`numbered 5,000,001 lines in ${elapsedMs.toFixed(1)} ms`);
  });
});

describe("host shell resource controls", () => {
  test("bounds admission and removes aborted waiters", async () => {
    const capacity = new ShellCapacity(1, 1);
    const releaseFirst = await capacity.acquire();
    const controller = new AbortController();
    const queued = capacity.acquire(controller.signal);

    expect(capacity.snapshot()).toEqual({ active: 1, queued: 1 });
    await expect(capacity.acquire()).rejects.toThrow("queue is full");
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    expect(capacity.snapshot()).toEqual({ active: 1, queued: 0 });

    releaseFirst();
    expect(capacity.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test("holds global permits for backgrounded commands until their OS children exit", () =>
    tempRoot("capacity", async (root) => {
      const script = join(root, "record-start.cjs");
      const marker = join(root, "starts.txt");
      await writeFile(script, 'require("node:fs").appendFileSync(process.argv[2], process.argv[3] + "\\n"); setTimeout(() => process.exit(0), 350);');
      const starts = () => readFile(marker, "utf8").then((text) => text.trim().split("\n"), () => []);
      const start = (id: string) =>
        executeShell({ command: `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(marker)} ${id}`, working_directory: root, block_until_ms: 0 }, root, undefined, { maxRuntimeMs: 5_000, terminationGraceMs: 25 });
      expect((await start("first")).status).toBe("running");
      expect((await start("second")).status).toBe("running");
      await waitFor(async () => (await starts()).length === 2);

      let thirdResolved = false;
      const third = start("third").then((result) => { thirdResolved = true; return result; });
      await Bun.sleep(50);
      expect(thirdResolved).toBe(false);
      expect(hostShellCapacitySnapshot()).toEqual({ active: 2, queued: 1 });
      expect(await starts()).toHaveLength(2);
      expect((await third).status).toBe("running");
      await waitFor(() => hostShellCapacitySnapshot().active === 0);
      expect((await starts())[2]).toBe("third");
    }), 8_000);

  const posixTest = process.platform === "win32" ? test.skip : test;

  posixTest("terminates redirected descendants before releasing their permit", () =>
    tempRoot("background", async (root) => {
      const marker = join(root, "background-pid.txt");
      const script = join(root, "background.cjs");
      await writeFile(script, 'const d = require("node:child_process").spawn("sleep", ["20"], { stdio: "ignore" }); d.unref(); require("node:fs").writeFileSync(process.argv[2], String(d.pid));');
      const result = await executeShell({ command: `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(marker)}`, working_directory: root, block_until_ms: 5_000 }, root, undefined, { maxRuntimeMs: 5_000, terminationGraceMs: 50 });
      expect(result.status).toBe("completed");
      await allExited(await readPids(marker));
      expect(hostShellCapacitySnapshot()).toEqual({ active: 0, queued: 0 });
    }), 8_000);

  posixTest("reports runtime expiry and force-kills descendants that ignore SIGTERM", () =>
    tempRoot("timeout", async (root) => {
      const tree = await createLongProcessTree(root, "timeout");
      const result = await executeShell({ command: tree.command, working_directory: root, block_until_ms: 5_000 }, root, undefined, { maxRuntimeMs: 250, terminationGraceMs: 50 });
      expect(result.status).toBe("failed");
      expect(result.output).toContain("timed out after 250 ms");
      expect(await readFile(result.output_path, "utf8")).toMatch(/\nstatus: aborted  \n[^]*\n---\nexit_code: (-?\d+|unknown)\nelapsed_ms: \d+\nended_at: \S+\n---\n$/);
      await allExited(await readPids(tree.marker));
    }), 8_000);

  posixTest("cancellation force-kills the whole process group and closes its log", () =>
    tempRoot("cancel", async (root) => {
      const tree = await createLongProcessTree(root, "cancel");
      const controller = new AbortController();
      const running = executeShell({ command: tree.command, working_directory: root, block_until_ms: 5_000 }, root, controller.signal, { maxRuntimeMs: 5_000, terminationGraceMs: 50 });
      const pids = await readPids(tree.marker);
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      await allExited(pids);
      const [logName] = (await readdir(root)).filter((name) => name.endsWith(".log"));
      expect(await readFile(join(root, logName!), "utf8")).toContain("\nstatus: aborted  \n");
    }), 8_000);

  posixTest("shutdown drains backgrounded process trees before returning", () =>
    tempRoot("shutdown", async (root) => {
      const tree = await createLongProcessTree(root, "shutdown");
      const result = await executeShell({ command: tree.command, working_directory: root, block_until_ms: 0 }, root, undefined, { maxRuntimeMs: 5_000, terminationGraceMs: 50 });
      expect(result.status).toBe("running");
      const pids = await readPids(tree.marker);
      await terminateHostChildren();
      expect(hostShellCapacitySnapshot()).toEqual({ active: 0, queued: 0 });
      await allExited(pids);
      expect(await readFile(result.output_path, "utf8")).toContain("\nstatus: aborted  \n");
    }), 8_000);
});

test("host background completion does not restore an old exported variable", () =>
  tempRoot("env-overlap", async (root) => {
    const run = (command: string, block_until_ms?: number) => executeShell({ command, working_directory: root, block_until_ms }, root);
    await run("export STATEQA_VALUE=initial STATEQA_REMOVE=present");
    const bg = await run(`for i in {1..100}; do test -f '${root}/release' && break; sleep 0.05; done; sleep 0.1`, 0);
    await run(`export STATEQA_VALUE=foreground; unset STATEQA_REMOVE; touch '${root}/release'`);
    await executeHostJob({ kind: "await-shell", input: { shell_id: bg.shell_id, block_until_ms: 5000 }, terminalDir: root });
    expect(JSON.stringify(await run('printf "%s|%s" "$STATEQA_VALUE" "${STATEQA_REMOVE-unset}"'))).toContain("foreground|unset");
  }));
