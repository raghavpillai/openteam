import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellJobRegistry, terminalFooter } from "../src";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function fixture(output = "alpha\nbeta\n") {
  const root = await mkdtemp(join(tmpdir(), "await-shell-"));
  roots.push(root);
  const outputPath = join(root, "job.log");
  const header = "command: header-only\n\n";
  await writeFile(outputPath, header + output + "\nexit_code: 0\n");
  const registry = new ShellJobRegistry();
  const job = registry.start({
    id: "job",
    scope: "bot-1",
    outputPath,
    outputOffset: Buffer.byteLength(header),
    startedAt: Date.now(),
  });
  job.outputWritten(Buffer.byteLength(output));
  return { registry, job, outputPath };
}

test("validates waits and rejects unknown, cross-scope, and path-like handles", async () => {
  const { registry } = await fixture();
  for (const input of [{ block_until_ms: Infinity }, { block_until_ms: 7_140_001 }])
    await expect(registry.await(input, "bot-1")).rejects.toThrow("AwaitShell");
  for (const input of [{ block_until_ms: 0 }, { shell_id: "", block_until_ms: 0 }])
    await expect(registry.await(input, "bot-1")).rejects.toThrow(
      "Invalid arguments:\nshell_id: Required when block_until_ms is 0. Without shell_id there is nothing to check: pass the shell_id to check, or a nonzero block_until_ms to sleep."
    );
  await expect(registry.await({ shell_id: "job", pattern: "[" }, "bot-1")).rejects.toThrow(
    "pattern is not valid RE2 syntax: missing closing ]. RE2 has no lookahead, lookbehind or backreferences."
  );
  for (const id of ["unknown", "../job", "/tmp/job"]) {
    await expect(registry.await({ shell_id: id, block_until_ms: 0 }, "bot-1")).rejects.toThrow(
      `No shell found for id ${id}`
    );
  }
  await expect(registry.await({ shell_id: "job", block_until_ms: 0 }, "bot-2")).rejects.toThrow(
    "No shell found for id job"
  );
});

test("restart recovers an in-flight terminal and retries completion delivery once", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-restart-")); roots.push(root);
  const outputPath = join(root, "700.log");
  await writeFile(outputPath, "header\nready\n");
  const original = new ShellJobRegistry({ directory: root });
  const job = original.start({ id: "700", scope: "bot", automationRunId: "automation-run", outputPath, outputOffset: 7, startedAt: Date.now() });
  job.outputWritten(6); original.markBackground("700");
  let attempts = 0;
  const recovered = new ShellJobRegistry({ directory: root, onComplete: async (receipt) => { expect(receipt.automationRunId).toBe("automation-run"); if (++attempts === 1) throw new Error("offline"); } });
  try {
    await writeFile(outputPath, `header\nready\n${terminalFooter(3, 100)}`);
    await recovered.flushCompletions(); await recovered.flushCompletions(); await recovered.flushCompletions();
    expect(attempts).toBe(2);
    expect(await recovered.await({ shell_id: "700", block_until_ms: 0 }, "bot")).toMatchObject({ status: "completed", exit_code: 3 });
    const again = new ShellJobRegistry({ directory: root, onComplete: async () => { attempts++; } });
    try { await again.flushCompletions(); expect(attempts).toBe(2); } finally { again.dispose(); }
    await expect(recovered.await({ shell_id: "700", block_until_ms: 0 }, "another-bot")).rejects.toThrow("No shell found for id 700");
  } finally { recovered.dispose(); }
});
