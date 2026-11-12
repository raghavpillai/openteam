import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerRuntime } from "../../src/runtime";

for (const failure of [false, true]) {
  test(`SendIMessage stages box files until the server snapshots them and cleans up on ${failure ? "failure" : "success"}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "imessage-runtime-")));
    const oldWorkspace = process.env.OPENTEAM_WORKSPACE_ROOT;
    const oldState = process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT;
    const oldFetch = globalThis.fetch;
    process.env.OPENTEAM_WORKSPACE_ROOT = root;
    process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT = join(root, "state");
    const source = join(root, "report.pdf");
    const bytes = "%PDF-1.7\nexact box bytes";
    let staged = "";
    let requests = 0;
    try {
      await writeFile(source, bytes);
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        requests++;
        const body = JSON.parse(String(init.body));
        expect(body.tool).toBe("SendIMessage");
        expect(body.arguments.to).toBe("+15555550100");
        staged = body.arguments.attachmentPaths[0];
        expect(staged).not.toBe(source);
        expect(await readFile(staged, "utf8")).toBe(bytes);
        if (failure) return Response.json({ error: "snapshot refused" }, { status: 400 });
        return Response.json({
          sent: true,
          message_id: "card",
          machine: "My Mac",
          delivery: "awaiting_approval",
        });
      }) as typeof fetch;
      const tools = (new ComputerRuntime() as any).tools;
      const result = tools.callControlPlaneTool({}, "call", "SendIMessage", {
        to: "+15555550100",
        attachmentPaths: [source],
      });
      if (failure) await expect(result).rejects.toThrow("snapshot refused");
      else expect((await result).content[0].text).toContain("Raised an approval card");
      expect(requests).toBe(1);
      expect(await readFile(staged).catch(() => null)).toBeNull();
      expect(await readFile(source, "utf8")).toBe(bytes);
      expect(await readdir(root)).toEqual(["report.pdf"]);
      await expect(
        tools.callControlPlaneTool({}, "missing", "SendIMessage", {
          to: "+15555550100",
          attachmentPaths: [join(root, "missing.pdf")],
        })
      ).rejects.toThrow("No file");
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldWorkspace === undefined) delete process.env.OPENTEAM_WORKSPACE_ROOT;
      else process.env.OPENTEAM_WORKSPACE_ROOT = oldWorkspace;
      if (oldState === undefined) delete process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT;
      else process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT = oldState;
      await rm(root, { recursive: true, force: true });
    }
  });
}
