import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("computer memory bootstrap rejects stale generations and unsafe readiness markers", () => {
  const result = spawnSync("python3", ["-B", join(import.meta.dir, "../../../scripts/test-computer-memory-setup.py")], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Memory bootstrap regressions failed: ${result.error ?? result.stderr}`);
  }
  expect(result.status).toBe(0);
});
