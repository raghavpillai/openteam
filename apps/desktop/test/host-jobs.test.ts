import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeRead,
  executeShell,
  hostShellCapacitySnapshot,
  MAX_INLINE_BYTES,
  numberText,
  ShellCapacity,
  terminateHostChildren,
} from "../src/main/host-jobs";

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

const readPids = async (marker: string) =>
  (await readFile(marker, "utf8")).trim().split("\n").map(Number);

afterEach(async () => {
  await terminateHostChildren();
});

describe("host file text projection", () => {
  test("preserves line numbering, offsets, limits, CRLF, and trailing lines", () => {
    expect(numberText("alpha\r\nbeta\ngamma\n", undefined, undefined)).toEqual({
      text: "1: alpha\n2: beta\n3: gamma\n4: ",
      lines: 4,
    });
    expect(numberText("alpha\nbeta\ngamma", 2, 1)).toEqual({ text: "2: beta", lines: 1 });
    expect(numberText("alpha\nbeta\ngamma", -2, undefined)).toEqual({
      text: "2: beta\n3: gamma",
      lines: 2,
    });
    expect(numberText("alpha", 99, undefined)).toEqual({ text: "", lines: 0 });
  });

  test("bounds output without allocating a numbered copy of every input line", () => {
    const input = "x\n".repeat(5_000_000);
    const startedAt = performance.now();
    const result = numberText(input, undefined, undefined);
    const elapsedMs = performance.now() - startedAt;

    expect(result.lines).toBe(5_000_001);
    expect(result.text.length).toBeLessThanOrEqual(MAX_INLINE_BYTES + "\n… truncated".length);
    expect(result.text.endsWith("… truncated")).toBe(true);
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

  test("holds global permits for backgrounded commands until their OS children exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-shell-capacity-"));
    const script = join(root, "record-start.cjs");
    const marker = join(root, "starts.txt");
    await writeFile(
      script,
      [
        'const { appendFileSync } = require("node:fs");',
        "const [marker, id, duration] = process.argv.slice(2);",
        "appendFileSync(marker, `${id},${Date.now()}\\n`);",
        "setTimeout(() => process.exit(0), Number(duration));",
      ].join("\n"),
      "utf8"
    );
    const command = (id: string) =>
      `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(marker)} ${id} 350`;

    try {
      const first = await executeShell(
        { command: command("first"), working_directory: root, block_until_ms: 0 },
        root,
        undefined,
        { maxRuntimeMs: 5_000, terminationGraceMs: 25 }
      );
      const second = await executeShell(
        { command: command("second"), working_directory: root, block_until_ms: 0 },
        root,
        undefined,
        { maxRuntimeMs: 5_000, terminationGraceMs: 25 }
      );
      expect(first.status).toBe("running");
      expect(second.status).toBe("running");
      await waitFor(async () => {
        try {
          return (await readFile(marker, "utf8")).trim().split("\n").length === 2;
        } catch {
          return false;
        }
      });

      let thirdResolved = false;
      const third = executeShell(
        { command: command("third"), working_directory: root, block_until_ms: 0 },
        root,
        undefined,
        { maxRuntimeMs: 5_000, terminationGraceMs: 25 }
      ).then((result) => {
        thirdResolved = true;
        return result;
      });
      await Bun.sleep(50);

      expect(thirdResolved).toBe(false);
      expect(hostShellCapacitySnapshot()).toEqual({ active: 2, queued: 1 });
      expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(2);

      expect((await third).status).toBe("running");
      await waitFor(() => hostShellCapacitySnapshot().active === 0);
      const starts = (await readFile(marker, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split(",")[0]);
      expect(new Set(starts.slice(0, 2))).toEqual(new Set(["first", "second"]));
      expect(starts[2]).toBe("third");
    } finally {
      await terminateHostChildren();
      await rm(root, { recursive: true, force: true });
    }
  }, 8_000);

  test("shares the global process-tree permits with PDF extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-pdf-capacity-"));
    const pdf = join(root, "queued.pdf");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(() => {}, 350)")}`;
    const controller = new AbortController();
    try {
      await writeFile(pdf, "%PDF-1.4\n", "utf8");
      await executeShell({ command, working_directory: root, block_until_ms: 0 }, root, undefined, {
        maxRuntimeMs: 5_000,
        terminationGraceMs: 25,
      });
      await executeShell({ command, working_directory: root, block_until_ms: 0 }, root, undefined, {
        maxRuntimeMs: 5_000,
        terminationGraceMs: 25,
      });
      const read = executeRead({ path: pdf }, controller.signal);
      await waitFor(() => hostShellCapacitySnapshot().queued === 1);
      expect(hostShellCapacitySnapshot()).toEqual({ active: 2, queued: 1 });
      controller.abort();
      await expect(read).rejects.toThrow("cancelled");
      expect(hostShellCapacitySnapshot()).toEqual({ active: 2, queued: 0 });
    } finally {
      await terminateHostChildren();
      await rm(root, { recursive: true, force: true });
    }
  }, 8_000);

  const posixTest = process.platform === "win32" ? test.skip : test;

  posixTest(
    "terminates redirected descendants before releasing their permit",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openbot-shell-background-"));
      const marker = join(root, "background-pid.txt");
      const script = join(root, "background.cjs");
      try {
        await writeFile(
          script,
          [
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            'const descendant = spawn("sleep", ["20"], { stdio: "ignore" });',
            "descendant.unref();",
            "writeFileSync(process.argv[2], String(descendant.pid));",
          ].join("\n"),
          "utf8"
        );
        const result = await executeShell(
          {
            command: `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(marker)}`,
            working_directory: root,
            block_until_ms: 5_000,
          },
          root,
          undefined,
          { maxRuntimeMs: 5_000, terminationGraceMs: 50 }
        );
        const pid = Number(await readFile(marker, "utf8"));
        expect(result.status).toBe("completed");
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        await waitFor(() => !processAlive(pid));
        expect(hostShellCapacitySnapshot()).toEqual({ active: 0, queued: 0 });
      } finally {
        await terminateHostChildren();
        await rm(root, { recursive: true, force: true });
      }
    },
    8_000
  );

  posixTest(
    "reports runtime expiry and force-kills descendants that ignore SIGTERM",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openbot-shell-timeout-"));
      const tree = await createLongProcessTree(root, "timeout");
      try {
        const result = await executeShell(
          { command: tree.command, working_directory: root, block_until_ms: 5_000 },
          root,
          undefined,
          { maxRuntimeMs: 250, terminationGraceMs: 50 }
        );
        expect(result.status).toBe("failed");
        expect(result.output).toContain("timed out after 250 ms");
        expect(await readFile(result.output_path, "utf8")).toContain("status: timed out");
        const pids = await readPids(tree.marker);
        await waitFor(() => pids.every((pid) => !processAlive(pid)));
      } finally {
        await terminateHostChildren();
        await rm(root, { recursive: true, force: true });
      }
    },
    8_000
  );

  posixTest(
    "cancellation force-kills the whole process group and closes its log",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openbot-shell-cancel-"));
      const tree = await createLongProcessTree(root, "cancel");
      const controller = new AbortController();
      try {
        const running = executeShell(
          { command: tree.command, working_directory: root, block_until_ms: 5_000 },
          root,
          controller.signal,
          { maxRuntimeMs: 5_000, terminationGraceMs: 50 }
        );
        await waitFor(async () => {
          try {
            await readFile(tree.marker);
            return true;
          } catch {
            return false;
          }
        });
        const pids = await readPids(tree.marker);
        controller.abort();
        await expect(running).rejects.toThrow("cancelled");
        await waitFor(() => pids.every((pid) => !processAlive(pid)));
        const [logName] = (await readdir(root)).filter((name) => name.endsWith(".log"));
        expect(logName).toBeDefined();
        expect(await readFile(join(root, logName as string), "utf8")).toContain(
          "status: cancelled"
        );
      } finally {
        await terminateHostChildren();
        await rm(root, { recursive: true, force: true });
      }
    },
    8_000
  );

  posixTest(
    "shutdown drains backgrounded process trees before returning",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openbot-shell-shutdown-"));
      const tree = await createLongProcessTree(root, "shutdown");
      try {
        const result = await executeShell(
          { command: tree.command, working_directory: root, block_until_ms: 0 },
          root,
          undefined,
          { maxRuntimeMs: 5_000, terminationGraceMs: 50 }
        );
        expect(result.status).toBe("running");
        await waitFor(async () => {
          try {
            await readFile(tree.marker);
            return true;
          } catch {
            return false;
          }
        });
        const pids = await readPids(tree.marker);
        await terminateHostChildren();

        expect(hostShellCapacitySnapshot()).toEqual({ active: 0, queued: 0 });
        await waitFor(() => pids.every((pid) => !processAlive(pid)));
        expect(await readFile(result.output_path, "utf8")).toContain(
          "status: terminated: app shutting down"
        );
      } finally {
        await terminateHostChildren();
        await rm(root, { recursive: true, force: true });
      }
    },
    8_000
  );
});
