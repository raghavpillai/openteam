import { expect, test } from "bun:test";
import { join } from "node:path";

test("packaged local MCP preserves arguments, cwd, environment and tool changes across restarts", async () => {
  // Run the real transport outside Bun's test-runner subprocess shim.
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/packaged-manager-smoke.ts")],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(stderr).toBe("");
  expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "" });
}, 15_000);
