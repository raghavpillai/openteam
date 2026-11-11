import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of ["read", "write"]) test(`garbage-collecting completed ${mode} transfers cannot close unrelated descriptors`, async () => {
  // A broken runtime closes live descriptors, so keep that corruption isolated
  // from the test runner and from any other tests sharing its process.
  const fixture = fileURLToPath(new URL("./fixtures/stream-descriptor-ownership.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture, mode], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout.trim())).toEqual({ transferred: 64, unexpectedlyClosed: 0 });
}, 30_000);

for (const mode of ["early-empty", "early-chunks", "early-read-only", "early-abort"])
  test(`a failed transfer cannot write a receipt to a reused descriptor (${mode})`, async () => {
    const fixture = fileURLToPath(new URL("./fixtures/stream-descriptor-ownership.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, fixture, mode], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ failedAsExpected: true, reusedReceipt: true, unexpectedlyChanged: 0 });
  }, 15_000);
