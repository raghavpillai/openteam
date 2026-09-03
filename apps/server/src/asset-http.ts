import { extname } from "node:path";
import type { AgentDataStore, AssetStore } from "@openteam/messaging";
import { corsHeaders } from "./http";

const assetFileName = (value: string | null): string => {
  const normalized = (value ?? "attachment").normalize("NFKC").trim();
  const leaf = normalized.split(/[\\/]/).at(-1) || "attachment";
  const safe = Array.from(leaf, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f || character === '"' || character === "\\"
      ? "_"
      : character;
  }).join("");
  return safe.slice(0, 180) || "attachment";
};

const rangeNotSatisfiable = (byteSize: number) =>
  new Response(null, {
    status: 416,
    headers: {
      ...corsHeaders,
      "accept-ranges": "bytes",
      "content-range": `bytes */${byteSize}`,
    },
  });

const browserContentType = (mimeType: string): string =>
  /^text\//i.test(mimeType) && !/;\s*charset=/i.test(mimeType)
    ? `${mimeType}; charset=utf-8`
    : mimeType;

export const assetResponse = async (
  assets: AssetStore,
  agentData: Pick<AgentDataStore, "agentAttachmentPath">,
  request: Request,
  url: URL,
  assetId: string
) => {
  let agentPath: string | null = null;
  const metadata = await assets.metadata(assetId).catch(async () => {
    // The content-addressed store is authoritative for normal asset reads.
    // Agent-local copies are a compatibility fallback and may require walking
    // every agent directory, so resolve them only after the central lookup
    // actually misses.
    agentPath = await agentData.agentAttachmentPath(assetId);
    if (!agentPath) throw new Error("Attachment not found");
    const file = Bun.file(agentPath);
    const extension = extname(agentPath).toLowerCase();
    const kinds = new Map<
      string,
      { mimeType: string; kind: "image" | "video" | "audio" | "pdf" | "text" }
    >([
      [".png", { mimeType: "image/png", kind: "image" }],
      [".jpg", { mimeType: "image/jpeg", kind: "image" }],
      [".jpeg", { mimeType: "image/jpeg", kind: "image" }],
      [".gif", { mimeType: "image/gif", kind: "image" }],
      [".webp", { mimeType: "image/webp", kind: "image" }],
      [".pdf", { mimeType: "application/pdf", kind: "pdf" }],
      [".mp4", { mimeType: "video/mp4", kind: "video" }],
      [".webm", { mimeType: "video/webm", kind: "video" }],
      [".mp3", { mimeType: "audio/mpeg", kind: "audio" }],
      [".wav", { mimeType: "audio/wav", kind: "audio" }],
      [".txt", { mimeType: "text/plain; charset=utf-8", kind: "text" }],
    ] as const);
    const detected = kinds.get(extension) ?? {
      mimeType: "application/octet-stream",
      kind: "file" as const,
    };
    return {
      assetId,
      byteSize: file.size,
      mimeType: detected.mimeType,
      kind: detected.kind,
      createdAt: new Date(file.lastModified).toISOString(),
    };
  });
  const file = Bun.file(agentPath ?? assets.contentPath(assetId));
  const range = request.headers.get("range");
  let start = 0;
  let end = metadata.byteSize - 1;
  let status = 200;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return rangeNotSatisfiable(metadata.byteSize);
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        return rangeNotSatisfiable(metadata.byteSize);
      }
      start = Math.max(0, metadata.byteSize - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= metadata.byteSize
    ) {
      return rangeNotSatisfiable(metadata.byteSize);
    }
    end = Math.min(end, metadata.byteSize - 1);
    status = 206;
  }
  const name = assetFileName(url.searchParams.get("name"));
  const inline = url.searchParams.get("download") !== "1" && metadata.kind !== "file";
  const headers = {
    ...corsHeaders,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-security-policy": "sandbox; default-src 'none'",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-length": String(end - start + 1),
    "content-type": browserContentType(metadata.mimeType),
    etag: `"${assetId}"`,
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${metadata.byteSize}` } : {}),
  };
  return new Response(request.method === "HEAD" ? null : file.slice(start, end + 1), {
    status,
    headers,
  });
};
