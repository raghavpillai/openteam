import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachmentLimitForName } from "@openteam/contracts/media-input";
import { stageAttachment } from "../src/attachment-staging";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

test("oversized and missing attachments name the file and the limit without staging or changing the source", async () => {
  const root = await tempDir("attachment-limit-");
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
});

test("staging ordinary and empty deliverables preserves names and denies hidden/symlink targets", async () => {
  const root=await tempDir("edge-stage-");
  const options={workspace:join(root,"workspace"),agentData:join(root,"state"),home:join(root,"home"),temporary:join(root,"tmp")};
  for(const dir of Object.values(options)) await mkdir(dir);
  for(const name of ["résumé 日本語 #1.txt","empty.txt"]) {
    const source=join(options.home,name);await writeFile(source,name==="empty.txt"?"":"canary");
    const staged=await stageAttachment(pathToFileURL(source).href,options);
    expect(await readFile(fileURLToPath(staged.url),"utf8")).toBe(name==="empty.txt"?"":"canary");
    expect(fileURLToPath(staged.url)).toEndWith(name);
    await staged.cleanup();
  }
  await mkdir(join(options.home,".private"));await writeFile(join(options.home,".private","secret"),"fixture");
  const alias=join(options.home,"innocent.txt");await symlink(join(options.home,".private","secret"),alias);
  await expect(stageAttachment(pathToFileURL(alias).href,options)).rejects.toThrow("ordinary box deliverable");
  expect(await readdir(options.workspace)).toEqual([]);
});

test("workspace delivery stages private runner files without changing source permissions or state policy", async () => {
  const root = await tempDir("private-delivery-");
  const options = {workspace:join(root,"workspace"),agentData:join(root,"state"),home:join(root,"home"),temporary:join(root,"tmp")};
  for (const dir of Object.values(options)) await mkdir(dir);
  const privateDir = await mkdtemp(join(options.workspace,"private-"));
  const source = join(privateDir,"report.txt");
  await writeFile(source,"private deliverable",{mode:0o600});
  const staged = await stageAttachment(pathToFileURL(source).href,options);
  expect(staged.url).not.toBe(pathToFileURL(source).href);
  expect(await readFile(fileURLToPath(staged.url),"utf8")).toBe("private deliverable");
  expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
  expect((await stat(source)).mode & 0o777).toBe(0o600);
  expect((await stat(fileURLToPath(staged.url))).mode & 0o777).toBe(0o644);
  await staged.cleanup();
  expect(await readdir(options.workspace)).toEqual([privateDir.split("/").at(-1)!]);
  const state = join(options.agentData,"settings.json");
  await writeFile(state,"protected fixture");
  const alias = join(options.workspace,"state-alias.txt");
  await symlink(state,alias);
  // Do not launder protected state through a newly staged workspace file.
  expect((await stageAttachment(pathToFileURL(alias).href,options)).url).toBe(pathToFileURL(alias).href);
  if (process.getuid?.() !== 0) {
    await chmod(source,0);
    await expect(stageAttachment(pathToFileURL(source).href,options)).rejects.toThrow();
    await chmod(source,0o600);
  }
});
