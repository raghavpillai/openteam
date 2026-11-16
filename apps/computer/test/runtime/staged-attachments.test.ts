// Tools that hand box files to the server stage a copy only until the server snapshots it.
import { expect, test } from "bun:test";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerRuntime } from "../../src/runtime";
import { tempDirs } from "../temp";
import { withFetch } from "./tool-fixtures";
const tempDir = tempDirs();

const CASES = {
  DraftExternalMessage: {
    file: "notes.txt", bytes: "Exact reviewed bytes.", reply: "Draft review card created.", shown: "Draft review card created",
    args: (files: string[]) => ({ platform: "email", providerIdentifier: "mail", from: "me@example.com", to: ["qa@example.com"], subject: "Fwd: Test", body: "Review only", forwardMessageId: "original", attachments: files }),
    staged: (args: any) => { expect(args.forwardMessageId).toBe("original"); return args.attachments[0]; },
  },
  SendIMessage: {
    file: "report.pdf", bytes: "%PDF-1.7\nexact box bytes", reply: { sent: true, message_id: "card", machine: "My Mac", delivery: "awaiting_approval" }, shown: "Raised an approval card",
    args: (files: string[]) => ({ to: "+15555550100", attachmentPaths: files }),
    staged: (args: any) => { expect(args.to).toBe("+15555550100"); return args.attachmentPaths[0]; },
  },
};

for (const [tool, spec] of Object.entries(CASES))
  for (const failure of [false, true])
    test(`${tool} stages box files until the server snapshots them and cleans up on ${failure ? "failure" : "success"}`, async () => {
      const root = await realpath(await tempDir("staged-attachments-"));
      const previous = { workspace: process.env.OPENTEAM_WORKSPACE_ROOT, state: process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT };
      process.env.OPENTEAM_WORKSPACE_ROOT = root;
      process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT = join(root, "state");
      const source = join(root, spec.file);
      let staged = "", requests = 0;
      const host = async (_url: unknown, init: RequestInit) => {
        requests++;
        const body = JSON.parse(String(init.body));
        expect(body.tool).toBe(tool);
        staged = spec.staged(body.arguments);
        expect(staged).not.toBe(source);
        expect(await readFile(staged, "utf8")).toBe(spec.bytes);
        return failure ? Response.json({ error: "snapshot refused" }, { status: 400 }) : Response.json(spec.reply);
      };
      try {
        await writeFile(source, spec.bytes);
        const tools = (new ComputerRuntime() as any).tools;
        const call = (id: string, files: string[]) => withFetch(host, () => tools.callControlPlaneTool({}, id, tool, spec.args(files)));
        const result = call("call", [source]);
        if (failure) await expect(result).rejects.toThrow("snapshot refused");
        else expect(((await result) as any).content[0].text).toContain(spec.shown);
        expect(requests).toBe(1);
        expect(await readFile(staged).catch(() => null)).toBeNull();
        expect(await readFile(source, "utf8")).toBe(spec.bytes);
        expect(await readdir(root)).toEqual([spec.file]);
        // A later missing file must also clean up files staged earlier in this call.
        await expect(call("missing", [source, join(root, "missing.txt")])).rejects.toThrow("No file");
        expect(requests).toBe(1);
        expect(await readdir(root)).toEqual([spec.file]);
      } finally {
        if (previous.workspace === undefined) delete process.env.OPENTEAM_WORKSPACE_ROOT;
        else process.env.OPENTEAM_WORKSPACE_ROOT = previous.workspace;
        if (previous.state === undefined) delete process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT;
        else process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT = previous.state;
      }
    });
