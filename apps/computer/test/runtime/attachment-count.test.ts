import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentRoots, loadAttachmentImages } from "../../src/runtime/attachments";

test("attachment overflow is reported instead of silently dropping the ninth file", async () => {
  const previous = process.env.OPENTEAM_AGENT_DATA_ROOT;
  const dir = await realpath(await mkdtemp(join(tmpdir(), "attachment-count-")));
  process.env.OPENTEAM_AGENT_DATA_ROOT = dir;
  const owner = "11111111-1111-4111-8111-111111111111";
  try {
    const root = attachmentRoots(owner)[1]!;
    await mkdir(root, { recursive: true });
    const paths = await Promise.all(
      Array.from({ length: 9 }, async (_, i) => {
        const path = join(root, `${i}.png`);
        await writeFile(path, Buffer.from(`distinct image ${i}`));
        return path;
      })
    );
    expect((await loadAttachmentImages(root, paths.slice(0, 8), owner)).images).toHaveLength(8);
    await expect(loadAttachmentImages(root, paths, owner)).rejects.toThrow("at most 8");
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
      for (const imageCount of [1, 6]) {
        const loaded = await loadAttachmentImages(
          root,
          [video, video, ...Array(imageCount).fill(image)],
          owner
        );
        try {
          expect(loaded.images.length).toBeLessThanOrEqual(16);
          expect(loaded.images.slice(-imageCount)).toEqual(
            Array(imageCount).fill({
              type: "image",
              mimeType: "image/png",
              data: png.toString("base64"),
            })
          );
          expect(loaded.images.filter((image) => image.mimeType === "image/jpeg").length).toBe(
            16 - imageCount
          );
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
