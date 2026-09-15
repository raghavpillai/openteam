/** Run against a dedicated, disposable database: a worker owns its whole queue. */
import { resolve } from "node:path";

if (!process.env.OPENTEAM_TEST_DATABASE_URL) {
  throw new Error(
    "Set OPENTEAM_TEST_DATABASE_URL to a dedicated test database with the current schema. Refusing to silently skip database and worker memory checks."
  );
}
const suites = [
  [
    "packages/messaging/test/memory-learning.test.ts",
    "packages/messaging/test/memory-synthesis.test.ts",
    "packages/messaging/test/memory-state-parity.test.ts",
    "packages/messaging/test/memory-tool-reference.test.ts",
    "packages/messaging/test/memory-render-reference.test.ts",
    "packages/messaging/test/recall-memory.test.ts",
    "packages/messaging/test/prompt-context-performance.test.ts",
    "apps/worker/test/memory-recording.test.ts",
    "apps/worker/test/memory-inference.test.ts",
    "apps/worker/test/context-routing.test.ts",
  ],
  [
    "packages/messaging/test/memory-parity.integration.test.ts",
    "packages/messaging/test/memory-recovery.integration.test.ts",
    "packages/messaging/test/memory-scopes.integration.test.ts",
  ],
  ["apps/server/test/memory-tools.integration.test.ts", "apps/server/test/memory-management.integration.test.ts"],
  ["apps/desktop/test/memory-view.test.ts"],
  ["apps/worker/test/memory-routing.integration.test.ts"],
  ["apps/worker/test/memory-restart.integration.test.ts"],
  [
    "apps/computer/test/bot-compaction.test.ts",
    "apps/computer/test/runtime/compaction.test.ts",
    "apps/computer/test/compaction-parity.test.ts",
  ],
];
// Absolute paths prevent Bun's substring matching from including archived research copies.
for (const suite of suites) {
  const child = Bun.spawn(
    [process.execPath, "test", ...suite.map((path) => resolve(import.meta.dir, "../..", path))],
    {
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}
