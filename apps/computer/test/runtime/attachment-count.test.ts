import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentRoots, loadAttachmentImages } from "../../src/runtime/attachments";

test("attachment overflow is reported instead of silently dropping the 65th file", async () => {
  const previous = process.env.OPENTEAM_AGENT_DATA_ROOT;
  const dir = await realpath(await mkdtemp(join(tmpdir(), "attachment-count-")));
  process.env.OPENTEAM_AGENT_DATA_ROOT = dir;
  const owner = "11111111-1111-4111-8111-111111111111";
  try {
    const root = attachmentRoots(owner)[1]!;
    await mkdir(root, { recursive: true });
    const paths = await Promise.all(
      Array.from({ length: 65 }, async (_, i) => {
        const path = join(root, `${i}.png`);
        await writeFile(path, Buffer.from(`distinct image ${i}`));
        return path;
      })
    );
    expect((await loadAttachmentImages(root, paths.slice(0, 64), owner)).images).toHaveLength(64);
    await expect(loadAttachmentImages(root, paths, owner)).rejects.toThrow("A subagent can take at most 64 images in file_attachments. Attach fewer and try again.");
    await expect(loadAttachmentImages(root, [join(root, "missing.png")], owner)).rejects.toThrow(`Couldn't read the attached image ${join(root, "missing.png")}: it was not found or is over 25 MB.`);
  } finally {
    if (previous === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
    else process.env.OPENTEAM_AGENT_DATA_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("ffmpeg"))(
  "video frames cannot crowd later image attachments out of the model input",
  async () => {
    const previous = process.env.OPENTEAM_AGENT_DATA_ROOT;
    const dir = await realpath(await mkdtemp(join(tmpdir(), "attachment-video-count-")));
    process.env.OPENTEAM_AGENT_DATA_ROOT = dir;
    const owner = "11111111-1111-4111-8111-111111111111";
    try {
      const root = attachmentRoots(owner)[1]!;
      await mkdir(root, { recursive: true });
      const video = join(root, "clip.mp4");
      const generated = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=16x16:r=1:d=120",
          "-c:v",
          "mpeg4",
          video,
        ],
        { stdout: "ignore", stderr: "pipe" }
      );
      const error = await new Response(generated.stderr).text();
      expect(await generated.exited, error).toBe(0);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
        "base64"
      );
      const image = join(root, "last.png");
      await writeFile(image, png);
      // Each clip gives up to 12 frames; one slot stays reserved for every later attachment.
      const many = Array(60).fill(image);
      const crowded = await loadAttachmentImages(root, [video, video, ...many], owner);
      try {
        expect(crowded.images).toHaveLength(64);
        expect(crowded.images.slice(-60).every((item) => item.mimeType === "image/png")).toBe(true);
        expect(crowded.images.filter((item) => item.mimeType === "image/jpeg")).toHaveLength(4);
      } finally {
        await Promise.all(crowded.tempDirectories.map((path) => rm(path, { recursive: true, force: true })));
      }
      for (const imageCount of [1, 6]) {
        const loaded = await loadAttachmentImages(
          root,
          [video, video, ...Array(imageCount).fill(image)],
          owner
        );
        try {
          expect(loaded.images.length).toBeLessThanOrEqual(64);
          expect(loaded.images.slice(-imageCount)).toEqual(
            Array(imageCount).fill({
              type: "image",
              mimeType: "image/png",
              data: png.toString("base64"),
            })
          );
          expect(loaded.images.filter((image) => image.mimeType === "image/jpeg").length).toBe(24);
        } finally {
          await Promise.all(
            loaded.tempDirectories.map((path) => rm(path, { recursive: true, force: true }))
          );
        }
      }
    } finally {
      if (previous === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
      else process.env.OPENTEAM_AGENT_DATA_ROOT = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000
);
