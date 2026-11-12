import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerRuntime } from "../../src/runtime";

for (const failure of [false, true]) {
  test(`email draft stages attachment bytes until host ingestion and cleans up on ${failure ? "failure" : "success"}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "email-draft-runtime-")));
    const oldWorkspace = process.env.OPENTEAM_WORKSPACE_ROOT;
    const oldState = process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT;
    const oldFetch = globalThis.fetch;
    process.env.OPENTEAM_WORKSPACE_ROOT = root;
    process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT = join(root, "state");
    const source = join(root, "notes.txt"), bytes = "Exact reviewed bytes.";
    let staged = "", requests = 0;
    try {
      await writeFile(source, bytes);
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        requests++;
        const body = JSON.parse(String(init.body));
        expect(body.tool).toBe("DraftExternalMessage");
        expect(body.arguments.forwardMessageId).toBe("original");
        staged = body.arguments.attachments[0];
        expect(staged).not.toBe(source);
        expect(await readFile(staged, "utf8")).toBe(bytes);
        return failure ? Response.json({ error: "snapshot refused" }, { status: 400 }) : Response.json("Draft review card created.");
      }) as typeof fetch;
      const tools = (new ComputerRuntime() as any).tools;
      const args = { platform: "email", providerIdentifier: "mail", from: "me@example.com", to: ["qa@example.com"], subject: "Fwd: Test", body: "Review only", forwardMessageId: "original", attachments: [source] };
      const result = tools.callControlPlaneTool({}, "call", "DraftExternalMessage", args);
      if (failure) await expect(result).rejects.toThrow("snapshot refused");
      else expect((await result).content[0].text).toContain("Draft review card created");
      expect(requests).toBe(1);
      expect(await readFile(staged).catch(() => null)).toBeNull();
      expect(await readFile(source, "utf8")).toBe(bytes);
      expect(await readdir(root)).toEqual(["notes.txt"]);
      // A later missing file must also clean up files staged earlier in this call.
      await expect(tools.callControlPlaneTool({}, "missing", "DraftExternalMessage", { ...args, attachments: [source, join(root, "missing.txt")] })).rejects.toThrow("No file");
      expect(requests).toBe(1);
      expect(await readdir(root)).toEqual(["notes.txt"]);
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
