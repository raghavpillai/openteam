import { test, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";
test("named secrets enter the real shell without appearing in results, logs or persisted environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-process-secret-"));
  try {
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "unused-fixture" });
    const secret = "fixture-secrét-密-private";
    const result = await executor.shell(
      {
        command: 'test -n "$FIXTURE_PROCESS_SECRET" && printf "%s" "$FIXTURE_PROCESS_SECRET"',
        block_until_ms: 5000,
        working_directory: root,
      },
      root,
      undefined,
      undefined,
      "fixture-bot",
      { secretEnvironment: { FIXTURE_PROCESS_SECRET: secret }, secrets: [secret] }
    );
    expect((result.content[0] as any).text).toContain("```\n[REDACTED]\n```");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(String(result.details.outputPath), "utf8")).not.toContain(secret);
    const inspect = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await inspect(file);
        else expect((await readFile(file)).includes(Buffer.from(secret))).toBe(false);
      }
    };
    await inspect(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
