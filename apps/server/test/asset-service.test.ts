import { describe, expect, test } from "bun:test";
import { ApiError } from "@openteam/contracts";
import {
  assetUploadByteLimit,
  decodeFileNameHeader,
  isAssetUploadEnvelope,
  requireAssetBody,
} from "../src/services/asset-service";

describe("binary assets", () => {
  test("passes a raw request body through without reading or buffering it", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    expect(requireAssetBody(stream)).toBe(stream);
    expect(pulls).toBe(0);
    expect(() => requireAssetBody(null)).toThrow(ApiError);
  });

  test("uses the regular limit unless the MIME type or extension identifies video", () => {
    expect(assetUploadByteLimit("image/png", "image.png")).toBe(25 * 1024 * 1024);
    expect(assetUploadByteLimit("video/mp4", "attachment.bin")).toBe(200 * 1024 * 1024);
    expect(assetUploadByteLimit("application/octet-stream", "clip.MOV")).toBe(200 * 1024 * 1024);
  });

  test("distinguishes legacy JSON envelopes from raw JSON file uploads", () => {
    expect(isAssetUploadEnvelope("application/json; charset=utf-8", null)).toBeTrue();
    expect(isAssetUploadEnvelope("application/json", "report.json")).toBeFalse();
    expect(isAssetUploadEnvelope("application/json-patch+json", null)).toBeFalse();
  });

  test("safely decodes byte-safe Unicode filenames and tolerates malformed escapes", () => {
    expect(decodeFileNameHeader("%E6%88%AA%E5%9B%BE.png")).toBe("截图.png");
    expect(decodeFileNameHeader("100%.png")).toBe("100%.png");
    expect(decodeFileNameHeader(null)).toBeNull();
  });
});
