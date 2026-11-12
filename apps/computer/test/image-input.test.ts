import { describe, expect, test } from "bun:test";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { decodeInlineImages, MAX_IMAGE_BYTES } from "../src/runtime/attachments";
import { boundToolImage, prepareUserImages, repairImageHistory, resizeImageForModel } from "../src/runtime/image-input";

const Jimp = createJimp({ formats: [png] });
const dimensions = (bytes: Buffer) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
const smallImage = async () => {
  const bytes = await new Jimp({ width: 24, height: 16, color: 0x3579bdff }).getBuffer("image/png");
  return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
};

describe("model image input", () => {
  test("progressively reduces a noisy PNG until the encoded bytes fit the model target", async () => {
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

  test("allows 25 MiB inline transport and never silently drops the ninth image", () => {
    expect(MAX_IMAGE_BYTES).toBe(26_214_400);
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
    expect(decodeInlineImages([{ url: `data:image/png;base64,${bytes.toString("base64")}` }])).toHaveLength(1);
    const tiny = { url: "data:image/png;base64,AAAA" };
    expect(decodeInlineImages(Array.from({ length: 9 }, () => tiny))).toHaveLength(9);
    expect(() => decodeInlineImages([{ url: `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")}` }])).toThrow();
  });

  test("sends GIF images to the model as PNG, on both the upload and tool paths", async () => {
    // A 1x1 GIF89a.
    const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const result of [await resizeImageForModel(gif), await resizeImageForModel(gif, { preserveDimensions: true })]) {
      expect(result.mimeType).toBe("image/png");
      expect(result.data.subarray(0, 4)).toEqual(pngSignature);
      expect(dimensions(result.data)).toEqual([1, 1]);
    }
    const user = await prepareUserImages([{ type: "image", data: gif.toString("base64"), mimeType: "image/gif" }]);
    expect(user.images[0]?.mimeType).toBe("image/png");
    expect(await boundToolImage(gif, "image/gif")).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  test("reports malformed tool and user images without forwarding invalid bytes", async () => {
    const invalid = Buffer.from("not an image");
    expect(await boundToolImage(invalid, "image/png")).toEqual({ type: "text", text: "[image omitted: failed to process 12 bytes (image/png)]" });
    const user = await prepareUserImages([{ type: "image", data: invalid.toString("base64"), mimeType: "image/png" }]);
    expect(user.images).toEqual([]);
    expect(user.notice).toBe("[image omitted: failed to process 12 bytes (image/png)]");
  });

});

describe("image history repair", () => {
  test('model history preserves graphical screenshot coordinates but still bounds ordinary images', async () => {
    const bytes = await new Jimp({width:1280,height:800,color:0xffffffff}).getBuffer('image/png');
    for (const toolName of ['Computer', 'Screenshot', 'browser_snapshot', 'browser_click', 'Read']) {
      const message = { role:'toolResult',toolName,content:[{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}] };
      const [result] = await repairImageHistory([message]);
      const image = await Jimp.read(Buffer.from(result!.content[0]!.data,'base64'));
      expect([image.width,image.height]).toEqual(toolName==='Read'?[1024,640]:[1280,800]);
      expect(message.content[0]!.data).toBe(bytes.toString('base64'));
      expect((await repairImageHistory([message]))[0]).toBe(result);
    }
  });

  test('large graphical screenshots reduce encoding size without moving coordinates', async () => {
    const image = new Jimp({width:1280,height:800,color:0xffffffff});
    let seed=924;
    for(let i=0;i<image.bitmap.data.length;i+=4) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      image.bitmap.data[i]=seed&255; image.bitmap.data[i+1]=(seed>>>8)&255;
      image.bitmap.data[i+2]=(seed>>>16)&255;
    }
    const bytes=await image.getBuffer('image/png');
    expect(bytes.length).toBeGreaterThan(1024*1024);
    const [result]=await repairImageHistory([{role:'toolResult',toolName:'Computer',content:[{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}]}]);
    const part=result!.content[0]!;
    expect(part.type).toBe('image');
    const output=Buffer.from(part.data,'base64');
    expect(output.length).toBeLessThanOrEqual(1024*1024);
    // JPEG SOF dimensions are checked using the same decoder used at the boundary.
    const { createJimp: factory } = await import('@jimp/core');
    const { default: jpeg } = await import('@jimp/js-jpeg');
    const decoded=await factory({formats:[jpeg]}).read(output);
    expect([decoded.width,decoded.height]).toEqual([1280,800]);
  });

  test("concurrent history repair preserves ordering, notices, cache identity, and receipt isolation", async () => {
    const image = await smallImage();
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: "toolResult",
      toolName: "Computer",
      index,
      content: [
        { type: "text", text: `receipt-${index}` },
        { ...image },
        { type: "image", data: "invalid-image", mimeType: "image/png" },
        { ...image },
      ],
    }));
    const original = JSON.stringify(messages);
    const [first, second] = await Promise.all([
      repairImageHistory(messages),
      repairImageHistory(messages),
    ]);
    expect(first.map((message) => message.index)).toEqual(messages.map((message) => message.index));
    for (let index = 0; index < messages.length; index++) {
      const result = first[index]!;
      expect(second[index]).toBe(result);
      expect(result).not.toBe(messages[index]);
      expect(result.content[0]).toEqual({ type: "text", text: `receipt-${index}` });
      expect(result.content[1]).toEqual(image);
      expect(result.content[2]).toMatchObject({ type: "text" });
      expect(result.content[3]).toEqual(image);
      expect(result.content[1]).not.toBe(messages[index]!.content[1]);
    }
    expect(JSON.stringify(messages)).toBe(original);
    const repairedImage = first[0]!.content[1]!;
    const receiptImage = messages[0]!.content[1]!;
    if (!("data" in repairedImage) || !("data" in receiptImage)) throw new Error("Missing image");
    repairedImage.data = "changed output";
    expect(receiptImage.data).toBe(image.data);
  });

});
