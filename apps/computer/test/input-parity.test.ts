import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";
import { decodeInlineImages, MAX_IMAGE_BYTES } from "../src/runtime/attachments";
import {
  boundToolImage,
  prepareUserImages,
  resizeImageForModel,
  targetFitImageSize,
} from "../src/runtime/image-input";

const fixture = new URL("./fixtures/input-parity/shapes-2400x1600.png", import.meta.url);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-input-parity-"));
  roots.push(root);
  return root;
};
const dimensions = (bytes: Buffer) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

describe("GrokBot input parity at the runtime boundary", () => {
  test("progressively reduces a noisy PNG until the encoded bytes fit the model target", async () => {
    const Jimp = createJimp({ formats: [png] });
    const pixels = Buffer.alloc(1024 * 1024 * 4);
    let seed = 731;
    for (let i = 0; i < pixels.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[i] = seed & 255;
    }
    const original = await Jimp.fromBitmap({ data: pixels, width: 1024, height: 1024 }).getBuffer(
      "image/png"
    );
    expect(original.length).toBeGreaterThan(1_048_576);
    const result = await resizeImageForModel(original);
    expect(result.data.length).toBeLessThanOrEqual(1_048_576);
    expect(dimensions(result.data)[0]).toBeLessThan(1024);
    expect(dimensions(original)).toEqual([1024, 1024]);
  });

  test("extracts the real native PDF fixture and leaves its bytes intact", async () => {
    const root = await temporary();
    const file = join(root, "fixture.pdf");
    const original = await readFile(
      new URL("./fixtures/input-parity/fixture.pdf", import.meta.url)
    );
    await writeFile(file, original);
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.read({ path: file }, root);
    expect(
      result.content.some((item) => item.type === "text" && item.text.includes("PDF_"))
    ).toBeTrue();
    expect(await readFile(file)).toEqual(original);
  });

  test("matches the independently extracted host geometry, including thin-image exceptions", () => {
    // Oracle: host 886e13a, SHA d54bf2ea6a49e2dfad656c4889b4f202e92817fb00fa829aadbb6aa76dc5fecc.
    for (const [w, h, max, ew, eh, changed] of [
      [2400, 1600, 1024, 1024, 683, true],
      [1600, 2400, 1024, 683, 1024, true],
      [1024, 1024, 1024, 1024, 1024, false],
      [1025, 1025, 1024, 1024, 1024, true],
      [2400, 1600, 1280, 1280, 853, true],
      [16000, 8, 1024, 16000, 8, false],
      [16000, 7, 1024, 16000, 7, false],
      [16000, 16, 1024, 8000, 8, true],
    ] as const)
      expect(targetFitImageSize(w, h, max)).toEqual({
        width: ew,
        height: eh,
        needsResize: changed,
      });
  });

  test("normalizes the actual native QA PNG without changing its original bytes", async () => {
    const original = await readFile(fixture);
    const before = Buffer.from(original);
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "59829a0a91f48c82c3a20595375c3d99bb76dc6674dafa00b5f9e77e190a5105"
    );
    const result = await resizeImageForModel(original);
    expect(result.mimeType).toBe("image/png");
    expect(dimensions(result.data)).toEqual([1024, 683]);
    expect(result.data.length).toBeLessThanOrEqual(1_048_576);
    expect(original).toEqual(before);
    expect(dimensions(await readFile(fixture))).toEqual([2400, 1600]);
  });

  test("allows 25 MiB inline transport and never silently drops the ninth image", () => {
    expect(MAX_IMAGE_BYTES).toBe(26_214_400);
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
    expect(
      decodeInlineImages([{ url: `data:image/png;base64,${bytes.toString("base64")}` }])
    ).toHaveLength(1);
    const tiny = { url: "data:image/png;base64,AAAA" };
    expect(decodeInlineImages(Array.from({ length: 9 }, () => tiny))).toHaveLength(9);
    expect(() =>
      decodeInlineImages([
        { url: `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")}` },
      ])
    ).toThrow();
  });

  test("keeps failed tool-image bytes, but explicitly reports a failed user image", async () => {
    const invalid = Buffer.from("not an image");
    const tool = await boundToolImage(invalid, "image/png");
    expect(tool.data).toBe(invalid.toString("base64"));
    const user = await prepareUserImages([tool]);
    expect(user.images).toEqual([]);
    expect(user.notice).toBe("[image omitted: failed to process 12 bytes (image/png)]");
  });

  test("preserves a known WebP canvas and the box tool's no-codec passthrough", async () => {
    const canvas = Buffer.alloc(30);
    canvas.write("RIFF", 0);
    canvas.write("WEBP", 8);
    canvas.write("VP8X", 12);
    canvas.writeUIntLE(1455, 24, 3);
    canvas.writeUIntLE(839, 27, 3);
    expect((await resizeImageForModel(canvas)).data).toEqual(canvas);
    canvas.writeUIntLE(2399, 24, 3);
    canvas.writeUIntLE(1599, 27, 3);
    await expect(resizeImageForModel(canvas)).rejects.toThrow("WebP codec");
    expect((await resizeImageForModel(canvas, { webpWithoutCodec: "passthrough" })).data).toEqual(
      canvas
    );
  });

  test("native Read matches both full-file boundaries and recovers by paging", async () => {
    const root = await temporary();
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const equal = join(root, "equal.txt"),
      over = join(root, "over.txt");
    await writeFile(equal, "a".repeat(100_000));
    await writeFile(over, `BEGIN\n${"a".repeat(100_001)}\nEND`);
    const success = await executor.read({ path: equal }, root);
    expect(success.details).toMatchObject({ exceededLimit: false });
    expect(success.content[0]).toEqual({ type: "text", text: `     1|${"a".repeat(100_000)}` });
    const failure = await executor.read({ path: over }, root);
    expect(failure.details).toMatchObject({ exceededLimit: true });
    expect(JSON.stringify(failure.content)).toContain("Please use offset and limit parameters");
    expect(JSON.stringify(failure.content)).not.toContain("aaaa");
    expect((await executor.read({ path: over, offset: 1, limit: 1 }, root)).content[0]).toEqual({
      type: "text",
      text: "     1|BEGIN\n... 2 lines not shown ...",
    });
    expect((await executor.read({ path: over, offset: -1, limit: 1 }, root)).content[0]).toEqual({
      type: "text",
      text: "... 2 lines not shown ...\n     3|END",
    });
  });

  test("Read can page an uploaded document above the old 10 MiB whole-file cap", async () => {
    const root = await temporary();
    const file = join(root, "large.txt");
    await writeFile(file, `BEGIN\n${"x".repeat(11 * 1024 * 1024)}`);
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    expect((await executor.read({ path: file, offset: 1, limit: 1 }, root)).content[0]).toEqual({
      type: "text",
      text: "     1|BEGIN\n... 1 lines not shown ...",
    });
  });

  test("Read returns bounded image bytes while the attachment stays intact", async () => {
    const root = await temporary();
    const file = join(root, "shapes.png");
    await copyFile(fixture, file);
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.read({ path: file }, root);
    const image = result.content.find((item) => item.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type === "image")
      expect(dimensions(Buffer.from(image.data, "base64"))).toEqual([1024, 683]);
    expect(dimensions(await readFile(file))).toEqual([2400, 1600]);
  });
});
