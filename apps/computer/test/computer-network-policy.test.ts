import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("private bridge endpoint validation rejects unsafe configuration", async () => {
  const child = Bun.spawn(
    [
      "python3",
      resolve(import.meta.dirname, "../../../scripts/imessage-bridge-linux/test_network.py"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 5000);
