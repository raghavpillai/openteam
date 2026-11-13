import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Electron/module mocks and DOM globals belong to each fixture process. They must never
// replace auth or durable-send modules used by the rest of the repository's test suite.
test.each([
  "screenbot-ownership",
  "screenbot-bridge-ownership",
  "screenbot-delivery-generation",
])("%s in an isolated process", async (name) => {
  const child = Bun.spawn(
    [process.execPath, "test", resolve(import.meta.dir, "fixtures", `${name}.ts`)],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${name} failed (${code})\n${stdout}\n${stderr}`);
    expect(code).toBe(0);
  } finally {
    clearTimeout(timeout);
  }
}, 20_000);
