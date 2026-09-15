import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";
import { renderShellAwaitResult } from "@openteam/shell-jobs";

test("real box Shell and Read operations emit the captured success and missing-file formats", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-native-reference-"));
  const executor = new NativeToolExecutor({ agentDir: root, controlToken: "synthetic" });
  try {
    const shell = await executor.shell(
      { command: "printf fixture; exit 3", block_until_ms: 1000 },
      root,
      undefined,
      undefined,
      "fixture"
    );
    const text = shell.content.find((p) => p.type === "text")!.text;
    expect(text).toMatch(
      /^Exit code: 3\n\nCommand output:\n\n```\nfixture\n```\n\nCommand completed in \d+ ms\.\n\nShell state \(cwd, env vars\) persists for subsequent calls\.$/
    );
    const path = join(root, "read.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    const read = await executor.read({ path, offset: 2, limit: 1 }, root);
    expect(read.content).toEqual([
      { type: "text", text: "... 1 lines not shown ...\n     2|two\n... 2 lines not shown ..." },
    ]);
    const missing = await executor.read({ path: join(root, "missing") }, root);
    expect(missing.content).toEqual([{ type: "text", text: "Error: File not found" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("AwaitShell labels and units match the captured completed receipt", () => {
  expect(
    renderShellAwaitResult({
      status: "completed",
      waited_ms: 0,
      elapsed_ms: 25,
      exit_code: 0,
      output_path: "/tmp/shell.txt",
      output_length: 3,
    })
  ).toBe(
    "Task completed in 25ms with exit code: 0.\noutput_file_path: /tmp/shell.txt\noutput_length: 3"
  );
});
