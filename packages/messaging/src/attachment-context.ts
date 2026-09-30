import { basename, extname } from "node:path";
import type { AssetRef } from "@openteam/contracts";

/** Only describe paths actually materialized; never align metadata by array index,
 * since missing or invalid assets can be skipped during materialization. */
export function attachmentContext(paths: readonly string[], attachments: readonly AssetRef[]): string {
  return [...new Set(paths)].map((path) => {
    const matches = attachments.filter((asset) => {
      const candidate = extname(asset.fileName).toLowerCase();
      const extension = /^\.[a-z0-9]{1,12}$/.test(candidate) ? candidate : ".bin";
      return basename(path) === `${asset.assetId}${extension}`;
    });
    const names = [...new Set(matches.map((asset) => asset.fileName))];
    return `- ${JSON.stringify({ path,
      ...(names.length === 1 ? { original_filename: names[0] } : names.length ? { original_filenames: names } : {}),
      ...(matches[0] ? { byte_length: matches[0].byteSize, mime_type: matches[0].mimeType } : {}),
    })}`;
  }).join("\n");
}
