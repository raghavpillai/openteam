import { basename, extname } from "node:path";
import type { AssetRef } from "@openteam/contracts";

// Types the server recognizes from a file's bytes, for uploads whose name has no extension.
const EXTENSION_FROM_MIME: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf", "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};

/** The attachment's file name on the box: its own extension, else one for its detected type, so
 * PDF and video tools still recognize a file that arrived without a name. */
export function attachmentStorageName(asset: Pick<AssetRef, "assetId" | "fileName" | "mimeType">): string {
  const candidate = extname(asset.fileName).toLowerCase();
  const extension = /^\.[a-z0-9]{1,12}$/.test(candidate) ? candidate : EXTENSION_FROM_MIME[asset.mimeType] ?? ".bin";
  return `${asset.assetId}${extension}`;
}

/** Only describe paths actually materialized; never align metadata by array index,
 * since missing or invalid assets can be skipped during materialization. */
export function attachmentContext(paths: readonly string[], attachments: readonly AssetRef[]): string {
  return [...new Set(paths)].map((path) => {
    const matches = attachments.filter((asset) => basename(path) === attachmentStorageName(asset));
    const names = [...new Set(matches.map((asset) => asset.fileName))];
    return `- ${JSON.stringify({ path,
      ...(names.length === 1 ? { original_filename: names[0] } : names.length ? { original_filenames: names } : {}),
      ...(matches[0] ? { byte_length: matches[0].byteSize, mime_type: matches[0].mimeType } : {}),
    })}`;
  }).join("\n");
}
