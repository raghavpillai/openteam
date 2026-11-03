import { basename, extname } from "node:path";
import type { AssetRef } from "@openteam/contracts";
import { videoMimeForName } from "@openteam/contracts/media-input";

// Types the server recognizes from a file's bytes, for uploads whose name has no extension.
const EXTENSION_FROM_MIME: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf", "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};

/** The attachment's file name on the box: its own extension, else one for its detected type.
 * The reference falls back to `.bin` here, which leaves a nameless PDF unreadable and a nameless
 * video unwatchable; naming by the detected type keeps both usable. */
export function attachmentStorageName(asset: Pick<AssetRef, "assetId" | "fileName" | "mimeType">): string {
  const candidate = extname(asset.fileName).toLowerCase();
  const extension = /^\.[a-z0-9]{1,12}$/.test(candidate) ? candidate : EXTENSION_FROM_MIME[asset.mimeType] ?? ".bin";
  return `${asset.assetId}${extension}`;
}

type AttachedKind = "file" | "image" | "video";

// The reference's list suffixes, verbatim. Its attachments live in agent data, outside the
// box's agent store, which takes the shorter image wording.
const ATTACHED_MEDIA_LINE_SUFFIX: Readonly<Record<AttachedKind, string>> = {
  file: "",
  image: ": an image already shown to you inline, so use this path only when you need to send it on",
  video: ": a video, so hand this path to the watchVideo subagent via Task file_attachments to watch it",
};

/** The reference's attachment sizes: "658 B", "9.5 KB", "74 KB", "1.2 MB". */
export function formatAttachedFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export interface AttachedFilesContext {
  /** Follows the user's text inside <user_query>; empty when nothing was saved. */
  note: string;
  /** Precedes the turn's text when videos came with it; empty otherwise. */
  videos: string;
}

/**
 * What a turn tells the bot about the files that came with a user's message, worded as the
 * reference words it: files first, then the images it already sees inline, then videos, each
 * with its size. Only paths actually materialized are described; metadata is matched by stored
 * name, never by array index, since missing or invalid assets can be skipped.
 */
export function attachedFilesContext(paths: readonly string[], attachments: readonly AssetRef[],
  inlineAssetIds: ReadonlySet<string> = new Set()): AttachedFilesContext {
  const entries = [...new Set(paths)].map((path) => {
    const matches = attachments.filter((asset) => basename(path) === attachmentStorageName(asset));
    const kind: AttachedKind = matches.some((asset) => inlineAssetIds.has(asset.assetId)) ? "image"
      : videoMimeForName(path) ? "video" : "file";
    return { path, kind, size: matches[0]?.byteSize };
  });
  if (entries.length === 0) return { note: "", videos: "" };
  const ordered = (["file", "image", "video"] as const).flatMap((kind) => entries.filter((entry) => entry.kind === kind));
  const list = ordered.map(({ path, kind, size }) =>
    `\n- ${path}${size != null ? ` (${formatAttachedFileSize(size)})` : ""}${ATTACHED_MEDIA_LINE_SUFFIX[kind]}`).join("");
  const noun = ordered.length === 1 ? "a file" : "these files";
  const videos = ordered.filter((entry) => entry.kind === "video").map((entry) => `- ${entry.path}`);
  return {
    note: `The user attached ${noun}. They're stored off your box at the paths below, where Shell and the browser can't see them; open them with Read.${list}`,
    videos: videos.length
      ? `<attached_videos>\nThe following videos have been attached by the user and saved to your filesystem. You can watch them using your WatchVideo subagent.\n${videos.join("\n")}\n</attached_videos>`
      : "",
  };
}
