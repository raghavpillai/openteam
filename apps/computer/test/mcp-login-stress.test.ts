import { expect, test } from "bun:test";
import { join } from "node:path";

test("MCP login stress: bursts, independent connectors, crashes, cancellation, tokens and stale requests", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/stdio-login-stress.ts")],
    cwd: join(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.passed).toHaveLength(10);
  expect(result.childProcessesStarted).toBe(46);
}, 90_000);
