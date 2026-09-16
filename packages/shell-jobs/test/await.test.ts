import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellJobRegistry, validateShellWait, renderShellAwaitResult } from "../src";
import { parseHostAwaitShellRequest } from "@openteam/contracts/service-protocol";

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

test("matches earlier multiline output but never headers or footers", async () => {
  const { registry, job, outputPath } = await fixture();
  expect(
    await registry.await({ shell_id: "job", pattern: "^beta$", block_until_ms: 0 }, "bot-1")
  ).toMatchObject({
    status: "running",
    pattern_matched: true,
    output_length: Buffer.byteLength("command: header-only\n\nalpha\nbeta\n\nexit_code: 0\n"),
    output_path: outputPath,
  });
  job.finish(7);
  for (const pattern of ["header-only", "exit_code", "absent"]) {
    expect(
      await registry.await({ shell_id: "job", pattern, block_until_ms: 30_000 }, "bot-1")
    ).toMatchObject({ status: "completed", exit_code: 7, pattern_matched: false });
  }
});

test("validates waits and rejects unknown, cross-scope, and path-like handles", async () => {
  const { registry } = await fixture();
  for (const input of [
    { block_until_ms: 0 },
    { block_until_ms: Infinity },
    { block_until_ms: 7_140_001 },
    { shell_id: "job", pattern: "[" },
    { shell_id: "", block_until_ms: 0 },
  ])
    await expect(registry.await(input, "bot-1")).rejects.toThrow("AwaitShell");
  for (const id of ["unknown", "../job", "/tmp/job"]) {
    await expect(registry.await({ shell_id: id, block_until_ms: 0 }, "bot-1")).rejects.toThrow(
      "Unknown or expired"
    );
  }
  await expect(registry.await({ shell_id: "job", block_until_ms: 0 }, "bot-2")).rejects.toThrow(
    "Unknown or expired"
  );
});

test("supports sleeping and cancellation without changing job state", async () => {
  const { registry, job } = await fixture();
  const slept = await registry.await({ block_until_ms: 25 }, "bot-1");
  expect(slept.status).toBe("slept");
  expect(slept.waited_ms).toBeGreaterThanOrEqual(20);
  const controller = new AbortController();
  const pending = registry.await(
    { shell_id: "job", block_until_ms: 7_140_000 },
    "bot-1",
    controller.signal
  );
  controller.abort(new Error("test cancellation"));
  await expect(pending).rejects.toThrow("test cancellation");
  expect((await registry.await({ shell_id: "job", block_until_ms: 0 }, "bot-1")).status).toBe(
    "running"
  );
  job.finish(null, "process failed to spawn");
  expect(await registry.await({ shell_id: "job" }, "bot-1")).toMatchObject({
    status: "failed",
    error: "process failed to spawn",
    exit_code: null,
  });
  await expect(
    registry.await({ block_until_ms: 7_140_000 }, "bot-1", controller.signal)
  ).rejects.toThrow("test cancellation");
});

test("RE2 handles nested repetition without backtracking and reports oversized scans", async () => {
  const { registry, job } = await fixture("a".repeat(10_000) + "!");
  expect((await registry.await({ shell_id: "job", pattern: "(a+)+$", block_until_ms: 0 }, "bot-1")).pattern_matched).toBe(false);
  job.outputWritten(64 * 1024 * 1024);
  await expect(
    registry.await({ shell_id: "job", pattern: "x", block_until_ms: 0 }, "bot-1")
  ).rejects.toThrow("64 MiB");
  expect((await registry.await({ shell_id: "job", block_until_ms: 0 }, "bot-1")).status).toBe(
    "running"
  );
});

test("Grok-compatible wait normalization and nonempty RE2 matches", async () => {
  expect(parseHostAwaitShellRequest({ task_id: 123, block_until_ms: 2.9 })).toMatchObject({ shell_id: "123", block_until_ms: 2 });
  expect(parseHostAwaitShellRequest({ shell_id: " none ", pattern: "[" })).toEqual({ block_until_ms: 30000 });
  expect(validateShellWait({ block_until_ms: -1 })).toBe(30000);
  const { registry } = await fixture();
  expect((await registry.await({ shell_id: "job", pattern: "^", block_until_ms: 0 }, "bot-1")).pattern_matched).toBe(false);
  for (const pattern of ["(?<=a)b", "(a)\\1"]) await expect(registry.await({ shell_id: "job", pattern, block_until_ms: 0 }, "bot-1")).rejects.toThrow("RE2");
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
    await writeFile(outputPath, "header\nready\n\n\nstatus: completed\nexit_code: 3\nelapsed_ms: 100\n");
    await recovered.flushCompletions(); await recovered.flushCompletions(); await recovered.flushCompletions();
    expect(attempts).toBe(2);
    expect(await recovered.await({ shell_id: "700", block_until_ms: 0 }, "bot")).toMatchObject({ status: "completed", exit_code: 3 });
    const again = new ShellJobRegistry({ directory: root, onComplete: async () => { attempts++; } });
    try { await again.flushCompletions(); expect(attempts).toBe(2); } finally { again.dispose(); }
    await expect(recovered.await({ shell_id: "700", block_until_ms: 0 }, "another-bot")).rejects.toThrow("Unknown or expired");
  } finally { recovered.dispose(); }
});

test("observed completions do not emit stale notifications after the turn ends", async () => {
  const { outputPath } = await fixture();
  let active = true, deliveries = 0;
  const registry = new ShellJobRegistry({ onComplete: async () => { if (active) throw new Error("Turn active"); deliveries++; } });
  try {
    const job = registry.start({ id: "observed", scope: "bot", outputPath, outputOffset: 0, startedAt: Date.now() });
    registry.markBackground("observed"); job.finish(0);
    await registry.await({ shell_id: "observed", block_until_ms: 0 }, "bot");
    active = false; await registry.flushCompletions();
    expect(deliveries).toBe(0);
  } finally { registry.dispose(); }
});

test("AwaitShell renders running, pattern, sleep and error receipts in the reference format", async () => {
  expect(renderShellAwaitResult({status:"running",waited_ms:25,elapsed_ms:120,pattern_matched:false,output_path:"/tmp/test",output_length:30})).toBe("Task still running after 120ms... Pattern did NOT match.\noutput_file_path: /tmp/test\noutput_length: 30");
  expect(renderShellAwaitResult({status:"running",waited_ms:25,elapsed_ms:120,pattern_matched:true,regex_match:"ready",output_path:"/tmp/test",output_length:30})).toContain("120ms... Pattern matched: ready\n");
  expect(renderShellAwaitResult({status:"slept",waited_ms:1500})).toBe("Slept for 2s.");
  expect(renderShellAwaitResult({status:"failed",waited_ms:0,error:"failed to start"})).toBe("Error awaiting task: failed to start");
  const { registry } = await fixture("x".repeat(1200));
  const result = await registry.await({shell_id:"job",pattern:"x+",block_until_ms:0},"bot-1");
  expect(result.regex_match).toBe("x".repeat(500)+"..."+"x".repeat(500));
});

test("bounds completed handle retention while keeping running jobs", async () => {
  const { registry, outputPath } = await fixture();
  for (let i = 0; i < 257; i++) {
    registry
      .start({
        id: `done-${i}`,
        scope: "bot-1",
        outputPath,
        outputOffset: 0,
        startedAt: Date.now(),
      })
      .finish(0);
  }
  await expect(registry.await({ shell_id: "done-0", block_until_ms: 0 }, "bot-1")).rejects.toThrow(
    "expired"
  );
  expect((await registry.await({ shell_id: "done-256", block_until_ms: 0 }, "bot-1")).status).toBe(
    "completed"
  );
  expect((await registry.await({ shell_id: "job", block_until_ms: 0 }, "bot-1")).status).toBe(
    "running"
  );
});
