import type { AssetRef } from "@openbot/contracts";

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

const extensionFor = (fileName: string) =>
  fileName.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] ?? "";

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

export const formatAttachmentBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
