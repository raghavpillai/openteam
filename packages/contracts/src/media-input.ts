import { CLIENT_CAPABILITIES, type ClientCapabilities } from "./capabilities";

// GrokBot 0.47 / host 886e13a: the filename determines the upload allowance.
// A declared video MIME must not turn an arbitrary file into a 200 MiB upload.
export const VIDEO_MIME_FROM_EXTENSION: Readonly<Record<string, string>> = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

export const mediaExtension = (name: string): string => {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

export const videoMimeForName = (name: string): string | undefined =>
  VIDEO_MIME_FROM_EXTENSION[mediaExtension(name)];

export const attachmentLimitForName = (
  name: string,
  limits: ClientCapabilities["uploads"] = CLIENT_CAPABILITIES.uploads
): number => (videoMimeForName(name) ? limits.maxVideoBytes : limits.maxRegularBytes);

export type AttachmentRejection = "empty" | "too-large";

export const attachmentSizeRejection = (
  name: string,
  size: number | null | undefined,
  limits: ClientCapabilities["uploads"] = CLIENT_CAPABILITIES.uploads
): AttachmentRejection | null => {
  if (size === 0) return "empty";
  return typeof size === "number" && size > attachmentLimitForName(name, limits)
    ? "too-large"
    : null;
};

export const attachmentRejectionMessage = (
  name: string,
  reason: AttachmentRejection,
  limits: ClientCapabilities["uploads"] = CLIENT_CAPABILITIES.uploads
): string =>
  reason === "empty"
    ? `"${name}" is empty, so it wasn't attached.`
    : `"${name}" is too large to attach (max ${Math.round(attachmentLimitForName(name, limits) / 1024 / 1024)} MB${videoMimeForName(name) ? " for video" : ""}).`;

export const MAX_INLINE_IMAGE_BYTES = CLIENT_CAPABILITIES.uploads.maxRegularBytes;
export const MAX_INLINE_IMAGE_URL_LENGTH = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 128;
