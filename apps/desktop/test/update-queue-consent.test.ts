import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of [
  "restored-current",
  "restored-current-retry",
  "restored-complete",
  "restored-old",
  "restored-accepted",
  "fresh-current",
  "delayed-current-account-change",
]) {
  test(`update consent: ${scenario}`, async () => {
    // Isolate the hook's singleton, auth state, React adapter and storage per run.
    const child = Bun.spawn([
      process.execPath,
      resolve(import.meta.dir, "fixtures/update-queue-consent.ts"),
      scenario,
    ], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stdout + stderr).toBe(0);
      expect(stdout).toContain("consent-scenario: passed");
    } finally {
      clearTimeout(timer);
    }
  }, 15_000);
}
