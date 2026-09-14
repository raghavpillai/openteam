import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { scopedProcessEnvironment } from "@openteam/plugin-sdk";

// Isolate SDK child-process IO from Bun's test runner, matching the computer MCP tests.
test("desktop MCP authentication, isolation, reconnect, and authenticated Bot routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-mcp-result-"));
  const result = join(directory, "result.json");
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/desktop-mcp-smoke.ts"), result], {
      stdout: "pipe", stderr: "pipe", env: scopedProcessEnvironment(process.env),
    });
    const [code, , errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(result, "utf8")).passed).toHaveLength(3);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);
