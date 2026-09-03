import { ApiError } from "@openteam/contracts";
import { REGULAR_ASSET_LIMIT, VIDEO_ASSET_LIMIT } from "@openteam/messaging";

const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]);

export const MAX_ASSET_BYTES = VIDEO_ASSET_LIMIT;

/** Browsers only permit byte-safe request headers, so clients URI-encode Unicode names. */
export const decodeFileNameHeader = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const assetUploadByteLimit = (contentType: string, fileName: string | null): number => {
  const extension = fileName?.split(".").pop()?.toLowerCase() ?? "";
  return contentType.toLowerCase().startsWith("video/") || VIDEO_EXTENSIONS.has(extension)
    ? VIDEO_ASSET_LIMIT
    : REGULAR_ASSET_LIMIT;
};

export const isAssetUploadEnvelope = (
  contentType: string,
  encodedFileName: string | null
): boolean =>
  encodedFileName === null && /^application\/json(?:\s*;|\s*$)/i.test(contentType.trim());

export const requireAssetBody = (
  body: ReadableStream<Uint8Array> | null
): ReadableStream<Uint8Array> => {
  if (!body) throw new ApiError(400, "asset_body_required", "Asset body is required");
  return body;
};
