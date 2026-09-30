import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentPath, attachmentRoots, loadAttachmentImages } from "../../src/runtime/attachments";

test("attachment roots include only the trusted owner's uploads", () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  expect(attachmentRoots(owner)).toHaveLength(2);
  expect(attachmentRoots(owner)[1]).toEndWith(`/agents/${owner}/attachments`);
  expect(attachmentRoots("../../.pi")).toEqual(["/workspace"]);
});

test("media paths accept workspace and owner uploads but reject sibling and symlink escapes", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "attachment-scope-")));
  const workspace = join(dir,"workspace"), uploads = join(dir,"owner","attachments"), sibling = join(dir,"other","attachments");
  try {
    for (const root of [workspace,uploads,sibling]) { await mkdir(root,{recursive:true}); await writeFile(join(root,"image.png"),"fixture"); }
    const roots = [workspace,uploads];
    expect(await attachmentPath(workspace,"image.png",roots)).toBe(join(workspace,"image.png"));
    expect(await attachmentPath(workspace,join(uploads,"image.png"),roots)).toBe(join(uploads,"image.png"));
    await expect(attachmentPath(workspace,join(sibling,"image.png"),roots)).rejects.toThrow("owning agent");
    await expect(attachmentPath(workspace,"../other/attachments/image.png",roots)).rejects.toThrow("owning agent");
    await symlink(join(sibling,"image.png"),join(workspace,"escape.png"));
    await expect(attachmentPath(workspace,"escape.png",roots)).rejects.toThrow("resolves outside");
    const linkedRoot = join(dir,"linked-root");
    await symlink(sibling,linkedRoot);
    await expect(attachmentPath(workspace,join(linkedRoot,"image.png"),[linkedRoot])).rejects.toThrow("resolves outside");
  } finally { await rm(dir,{recursive:true,force:true}); }
});


test("a worker receives uploaded image bytes directly from its trusted parent's attachment directory", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "attachment-image-")));
  const previous = process.env.OPENTEAM_AGENT_DATA_ROOT;
  process.env.OPENTEAM_AGENT_DATA_ROOT = dir;
  const owner = "11111111-1111-4111-8111-111111111111";
  try {
    const root = attachmentRoots(owner)[1]!;
    await mkdir(root, { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    const path = join(root, "fixture.png");
    await writeFile(path, png);
    const loaded = await loadAttachmentImages("/workspace", [path], owner);
    expect(loaded.images).toEqual([{type:"image", mimeType:"image/png", data:png.toString("base64")}]);
    expect(loaded.tempDirectories).toEqual([]);
    const alias = dir + "-alias";
    await symlink(dir, alias);
    try {
      process.env.OPENTEAM_AGENT_DATA_ROOT = alias;
      const aliasedPath = join(attachmentRoots(owner)[1]!, "fixture.png");
      expect((await loadAttachmentImages("/workspace", [aliasedPath], owner)).images).toEqual(loaded.images);
    } finally {
      process.env.OPENTEAM_AGENT_DATA_ROOT = dir;
      await rm(alias);
    }
    await expect(loadAttachmentImages("/workspace", [path], "22222222-2222-4222-8222-222222222222")).rejects.toThrow("owning agent");
  } finally {
    if (previous === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
    else process.env.OPENTEAM_AGENT_DATA_ROOT = previous;
    await rm(dir, { recursive:true, force:true });
  }
});
