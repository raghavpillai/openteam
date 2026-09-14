import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import bmp, { msBmp } from "@jimp/js-bmp";
import gif from "@jimp/js-gif";
import tiff from "@jimp/js-tiff";
import { methods as resize } from "@jimp/plugin-resize";
import type { RuntimeImage } from "./types";

const Jimp = createJimp({ formats: [png, jpeg, bmp, msBmp, gif, tiff], plugins: [resize] });
export const MODEL_IMAGE_BYTE_TARGET = 1024 * 1024;
const MIN_DIMENSION = 8;

// Geometry and encoding loop mirror the inspected host 886e13a helper.
export const targetFitImageSize = (width: number, height: number, maxDimension = 1024) => {
  const unchanged = { width, height, needsResize: false };
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (width < 1 || height < 1 || long <= maxDimension || short < MIN_DIMENSION) return unchanged;
  let scale = maxDimension / long;
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  if (w < MIN_DIMENSION || h < MIN_DIMENSION) {
    scale = MIN_DIMENSION / short;
    w = Math.max(MIN_DIMENSION, Math.round(width * scale));
    h = Math.max(MIN_DIMENSION, Math.round(height * scale));
  }
  return { width: w, height: h, needsResize: w !== width || h !== height };
};

export const readWebpDimensions = (
  bytes: Buffer
): { width: number; height: number } | undefined => {
  if (
    bytes.length < 25 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return;
  switch (bytes.toString("ascii", 12, 16)) {
    case "VP8 ":
      if (bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42)
        return { width: bytes.readUInt16LE(26) & 16383, height: bytes.readUInt16LE(28) & 16383 };
      return;
    case "VP8L": {
      if (bytes[20] !== 47) return;
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
    }
    case "VP8X":
      if (bytes.length >= 30)
        return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
};

export const resizeImageForModel = async (
  bytes: Buffer,
  options: { webpWithoutCodec?: "passthrough"; preserveWebpDimensions?: boolean } = {}
): Promise<{ data: Buffer; mimeType: string }> => {
  const webp =
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  if (webp) {
    const dimensions = readWebpDimensions(bytes);
    const modelCanvas =
      dimensions &&
      ((dimensions.width === 1280 && dimensions.height === 800) ||
        (dimensions.width === 1456 && dimensions.height === 840));
    if (
      (options.preserveWebpDimensions && dimensions) ||
      options.webpWithoutCodec === "passthrough" ||
      (dimensions &&
        (modelCanvas ||
          !targetFitImageSize(dimensions.width, dimensions.height, 1280).needsResize) &&
        bytes.length <= MODEL_IMAGE_BYTE_TARGET)
    ) {
      return { data: bytes, mimeType: "image/webp" };
    }
    // The inspected box bundle has no registered WebP codec either. Its Read
    // wrapper passes through; its strict message middleware reports omission.
    throw new Error("WebP codec is not registered");
  }
  const image = await Jimp.read(bytes);
  const mimeType = image.mime ?? "image/png";
  const target = targetFitImageSize(image.width, image.height);
  if (!target.needsResize && bytes.length <= MODEL_IMAGE_BYTE_TARGET)
    return { data: bytes, mimeType };
  let { width, height } = target;
  if (target.needsResize) image.resize({ w: width, h: height });
  const encode = () => image.getBuffer(mimeType as Parameters<typeof image.getBuffer>[0]);
  let data = await encode();
  while (data.length > MODEL_IMAGE_BYTE_TARGET && width > MIN_DIMENSION && height > MIN_DIMENSION) {
    width = Math.max(MIN_DIMENSION, Math.round(width * 0.8));
    height = Math.max(MIN_DIMENSION, Math.round(height * 0.8));
    image.resize({ w: width, h: height });
    data = await encode();
  }
  return { data, mimeType };
};

/** Tool results keep their bytes on failure, as GrokBot's Read wrapper does. */
export const boundToolImage = async (bytes: Buffer, mimeType: string): Promise<RuntimeImage> => {
  try {
    const result = await resizeImageForModel(bytes, { webpWithoutCodec: "passthrough" });
    return { type: "image", data: result.data.toString("base64"), mimeType: result.mimeType };
  } catch {
    return { type: "image", data: bytes.toString("base64"), mimeType };
  }
};

/** Keep an explicit notice when a user image cannot be processed. */
export const prepareUserImages = async (images: readonly RuntimeImage[]) => {
  const bounded: RuntimeImage[] = [];
  const notices: string[] = [];
  for (const image of images) {
    const bytes = Buffer.from(image.data, "base64");
    try {
      const result = await resizeImageForModel(bytes);
      bounded.push({
        type: "image",
        data: result.data.toString("base64"),
        mimeType: result.mimeType,
      });
    } catch {
      notices.push(`[image omitted: failed to process ${bytes.length} bytes (${image.mimeType})]`);
    }
  }
  return { images: bounded, notice: notices.join("\n") };
};
