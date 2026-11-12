import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleApi } from "../_shared/google";

test("Google API errors surface actionable messages and redact tokens", async () => {
  const api = new GoogleApi("https://www.googleapis.com", "secret-token", async () =>
    Response.json({ error: { message: "Denied secret-token" } }, { status: 403 })
  );
  await expect(api.request("/drive/v3/files")).rejects.toThrow("Google API 403: Denied [redacted]");
});

test("Google connectors are standalone MCP executables with argument validation and explicit auth errors", async () => {
  // The real transport runs outside Bun's test-runner subprocess shim.
  const directory = await mkdtemp(join(tmpdir(), "plugin-smoke-report-"));
  try {
    const report = join(directory, "result.json");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/google-mcp-smoke.ts"), report], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await Bun.file(report).json()).toMatchObject({ plugins: 3, offlineSemanticSearch: true, pagedResult: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
