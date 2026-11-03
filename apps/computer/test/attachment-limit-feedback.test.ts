import { test, expect } from "bun:test";
import { mkdtemp, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attachmentLimitForName } from "@openteam/contracts/media-input";
import { stageAttachment } from "../src/attachment-staging";

test("oversized and missing attachments name the file and the limit without staging or changing the source", async () => {
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
      /^research\.zip is over the 25 MB attachment limit, so nothing was sent\. Compress, shrink, or split it on the box and attach the smaller file\.$/);
    const clip = join(options.home,"clip.mp4");
    const video = await open(clip,"wx");
    await video.truncate(attachmentLimitForName(clip) + 1);
    await video.close();
    await expect(stageAttachment(pathToFileURL(clip).href,options)).rejects.toThrow("clip.mp4 is over the 200 MB video attachment limit, so nothing was sent.");
    await expect(stageAttachment(pathToFileURL(join(options.workspace,"nope.pdf")).href,options)).rejects.toThrow(
      `No file at ${join(options.workspace,"nope.pdf")} on your box, so nothing was sent. Attachments come from the box.`);
    expect((await stat(source)).size).toBe(maximum + 1);
    expect(await readdir(options.workspace)).toEqual([]);
    await expect(stageAttachment(pathToFileURL(options.home).href,options)).rejects.toThrow("Attachment must be a regular file");
  } finally { await rm(root,{recursive:true,force:true}); }
});
