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

/** The reference's SendToUser refusal for an attachment path with no file behind it. */
export const missingAttachmentMessage = (path: string): string =>
  `No file at ${path} on your box, so nothing was sent. Attachments come from the box. For a file on one of the user's computers, copy it to the box with CopyToBox and attach the box path it returns; otherwise check the path and send again.`;

/** The reference's SendToUser refusal for an attachment over its size limit. */
export const tooLargeAttachmentMessage = (path: string): string => {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return `${name} is over the ${Math.floor(attachmentLimitForName(name) / (1024 * 1024))} MB ${videoMimeForName(name) ? "video attachment" : "attachment"} limit, so nothing was sent. Compress, shrink, or split it on the box and attach the smaller file.`;
};

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

// Task attachments are inline model media, not general shared filesystem inputs.
export const MAX_TASK_ATTACHMENTS = 64;
export const TASK_ATTACHMENT_LIMIT_MESSAGE = `A subagent can take at most ${MAX_TASK_ATTACHMENTS} images in file_attachments. Attach fewer and try again.`;
/** Each attached image, as in the reference. */
export const MAX_TASK_IMAGE_BYTES = 25 * 1024 * 1024;
export const unreadableTaskImageMessage = (path: string) =>
  `Couldn't read the attached image ${path}: it was not found or is over ${MAX_TASK_IMAGE_BYTES / 1024 / 1024} MB.`;
export const TASK_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp",
};
export const TASK_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
export const isTaskMediaPath = (path: string): boolean => {
  const extension = mediaExtension(path);
  return Boolean(TASK_IMAGE_MIME_TYPES[extension]) || TASK_VIDEO_EXTENSIONS.has(extension);
};
