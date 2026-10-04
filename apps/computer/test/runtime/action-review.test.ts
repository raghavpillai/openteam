import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTools } from "../../src/runtime/tools";

test("box shell executes directly without classifier calls or approval events", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-shell-"));
  const requests: string[] = [], events: unknown[] = [];
  const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) { requests.push(new URL(request.url).pathname); return Response.json({ environment: {} }); } });
  const tools = new RuntimeTools({} as any, api.url.origin, "fixture-control", root, root) as any;
  const active: any = { botId: crypto.randomUUID(), runId: crypto.randomUUID(), screenBotId: crypto.randomUUID(), cwd: root, queue: { push: (event: unknown) => events.push(event) }, requestSource: "user", runtimeProfile: "main" };
  try {
    const file = join(root, "result.txt");
    await tools.executeOpenTeamTool(active, "shell", "Shell", { command: `printf done > '${file}'`, block_until_ms: 1000 });
    expect(await readFile(file, "utf8")).toBe("done");
    expect(requests.some(path => path.includes("permissions"))).toBe(false);
    expect(events).toEqual([]);
    active.pendingSteers = [{ content: "Stop" }];
    await expect(tools.executeOpenTeamTool(active, "stale", "Shell", { command: "echo stale" })).rejects.toThrow("newer instruction");
  } finally { api.stop(true); await rm(root, { recursive: true, force: true }); }
});
