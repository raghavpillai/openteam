import type { AssetKind, AssetRef, ClientCapabilities } from "@openbot/contracts";

export type AttachmentPreviewKind =
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "text"
  | "json"
  | "table"
  | "docx"
  | "unknown";

export interface AttachmentCandidate {
  fileName: string;
  mimeType?: string | null;
  byteSize?: number | null;
}

const extensionFor = (fileName: string): string =>
  fileName.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] ?? "";

export const attachmentAssetKind = (
  candidate: Pick<AttachmentCandidate, "fileName" | "mimeType">
): AssetKind => {
  const mime = candidate.mimeType?.toLowerCase() ?? "";
  const extension = extensionFor(candidate.fileName);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime.startsWith("text/") || ["txt", "md", "markdown", "csv", "json"].includes(extension)) {
    return "text";
  }
  return "file";
};

export const attachmentIsVideo = (
  candidate: Pick<AttachmentCandidate, "fileName" | "mimeType">
): boolean =>
  candidate.mimeType?.toLowerCase().startsWith("video/") === true ||
  /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/i.test(candidate.fileName);

export const attachmentByteLimit = (
  candidate: Pick<AttachmentCandidate, "fileName" | "mimeType">,
  capabilities: ClientCapabilities["uploads"]
): number =>
  attachmentIsVideo(candidate) ? capabilities.maxVideoBytes : capabilities.maxRegularBytes;

export const firstOversizedAttachment = <T extends AttachmentCandidate>(
  candidates: readonly T[],
  capabilities: ClientCapabilities["uploads"]
): { candidate: T; limit: number } | null => {
  for (const candidate of candidates) {
    if (typeof candidate.byteSize !== "number") continue;
    const limit = attachmentByteLimit(candidate, capabilities);
    if (candidate.byteSize > limit) return { candidate, limit };
  }
  return null;
};

export const remainingAttachmentCapacity = (
  currentCount: number,
  capabilities: ClientCapabilities["uploads"]
): number => Math.max(0, capabilities.maxAttachmentsPerMessage - Math.max(0, currentCount));

export const attachmentOverflowMessage = (remaining: number): string =>
  `Only the first ${Math.max(0, Math.trunc(remaining))} files were added.`;

export const attachmentPreviewKind = (attachment: AssetRef): AttachmentPreviewKind => {
  const extension = extensionFor(attachment.fileName);
  if (attachment.kind === "video" || attachment.mimeType.startsWith("video/")) return "video";
  if (attachment.kind === "audio" || attachment.mimeType.startsWith("audio/")) return "audio";
  if (attachment.kind === "pdf" || extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (["xlsx", "xls", "csv", "tsv"].includes(extension)) return "table";
  if (extension === "json" || attachment.mimeType === "application/json") return "json";
  if (["md", "markdown", "mdx"].includes(extension)) return "markdown";
  if (attachment.kind === "text" || attachment.mimeType.startsWith("text/")) return "text";
  return "unknown";
};

export const formatAttachmentBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
