import { expect, test } from "bun:test";
import { join } from "node:path";

test("stdio MCP manager spawns, discovers, calls, reuses, and closes a local server", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures", "stdio-manager-smoke.ts")],
    cwd: join(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}, 15_000);
