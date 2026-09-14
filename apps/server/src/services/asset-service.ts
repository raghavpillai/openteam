import { ApiError } from "@openteam/contracts";
import { attachmentLimitForName } from "@openteam/contracts/media-input";
import { VIDEO_ASSET_LIMIT } from "@openteam/messaging";

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

export const assetUploadByteLimit = (_contentType: string, fileName: string | null): number =>
  attachmentLimitForName(fileName ?? "");

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
