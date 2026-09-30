import { test, expect } from "bun:test";
import { mkdtemp, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attachmentLimitForName } from "@openteam/contracts/media-input";
import { stageAttachment } from "../src/attachment-staging";

test("oversized archive reports actual and allowed bytes without staging or changing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "attachment-limit-"));
  try {
    const options = {workspace:join(root,"workspace"),agentData:join(root,"state"),home:join(root,"home"),temporary:join(root,"tmp")};
    for (const dir of Object.values(options)) await mkdir(dir);
    const source = join(options.home,"research.zip");
    const maximum = attachmentLimitForName(source);
    const handle = await open(source,"wx");
    await handle.truncate(maximum + 1); // Sparse file: exercise the real size check without allocating the archive.
    await handle.close();
    await expect(stageAttachment(pathToFileURL(source).href,options)).rejects.toThrow(
      `Attachment is ${maximum + 1} bytes; the limit for this file type is ${maximum} bytes`,
    );
    expect((await stat(source)).size).toBe(maximum + 1);
    expect(await readdir(options.workspace)).toEqual([]);
    await expect(stageAttachment(pathToFileURL(options.home).href,options)).rejects.toThrow("Attachment must be a regular file");
  } finally { await rm(root,{recursive:true,force:true}); }
});
