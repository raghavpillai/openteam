import { createHash } from "node:crypto";
import { createPublicHttpFetch } from "@openteam/plugin-sdk/public-http";

export const IMAGE_BYTE_LIMIT = 5 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Raster headers only: SVG/HTML and mismatched MIME never reach a decoder. */
export function rasterDimensions(bytes: Uint8Array, mime: string): [number, number] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: [number, number] | undefined;
  if (mime === "image/png" && b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.readUInt32BE(8) === 13 && b.toString("ascii", 12, 16) === "IHDR")
    dimensions = [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (mime === "image/jpeg" && b.length >= 4 && b[0] === 255 && b[1] === 216) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at++] !== 255) break;
      while (b[at] === 255) at++;
      const marker = b[at++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > b.length) break;
      const size = b.readUInt16BE(at);
      if (size < 2 || at + size > b.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        dimensions = [b.readUInt16BE(at + 5), b.readUInt16BE(at + 3)]; break;
      }
      at += size;
    }
  }
  if (mime === "image/webp" && b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" && b.readUInt32LE(4) + 8 === b.length) {
    const type = b.toString("ascii", 12, 16);
    if (type === "VP8X" && b.readUInt32LE(16) >= 10) dimensions = [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (type === "VP8 " && b[23] === 157 && b[24] === 1 && b[25] === 42) dimensions = [b.readUInt16LE(26) & 16383, b.readUInt16LE(28) & 16383];
    if (type === "VP8L" && b[20] === 47) dimensions = [1 + ((b[21]! | b[22]! << 8) & 16383), 1 + ((b[22]! >> 6 | b[23]! << 2 | b[24]! << 10) & 16383)];
  }
  if (!dimensions || dimensions.some(n => n < 1 || n > MAX_SIDE) || dimensions[0] * dimensions[1] > MAX_PIXELS)
    throw new Error("Invalid presentation image");
  return dimensions;
}

function imageURL(raw: string): URL {
  if (raw.length > 8192) throw new Error("Invalid presentation image");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid presentation image");
  url.hash = "";
  return url;
}

/** One global service: finite active sockets/body buffers and compressed cache cost. */
export function createPresentationImages(options: {
  fetch?: ReturnType<typeof createPublicHttpFetch>;
  deadlineMs?: number;
  now?: () => number;
} = {}) {
  const fetchImage = options.fetch ?? createPublicHttpFetch({ httpsOnly: true, accept: "image/png,image/jpeg,image/webp", byteLimit: () => IMAGE_BYTE_LIMIT });
  const now = options.now ?? Date.now;
  const cache = new Map<string, { bytes: Uint8Array; mime: string; expires: number }>();
  let cost = 0, active = 0;
  const waiting = new Set<() => void>();
  const acquire = (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    const abort = () => { waiting.delete(start); reject(new Error("Image cancelled")); };
    const start = () => {
      waiting.delete(start);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { reject(new Error("Image cancelled")); return; }
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; active--;
        waiting.values().next().value?.();
      });
    };
    if (signal.aborted) { abort(); return; }
    if (active < 4) { start(); return; }
    if (waiting.size >= 32) { reject(new Error("Image busy")); return; }
    waiting.add(start);
    signal.addEventListener("abort", abort, { once: true });
  });
  const remove = (key: string) => { cost -= cache.get(key)!.bytes.byteLength; cache.delete(key); };
  const response = (value: { bytes: Uint8Array; mime: string }) => new Response(new Uint8Array(value.bytes), { headers: {
    "content-type": value.mime, "content-length": String(value.bytes.byteLength),
    "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
  return async (request: Request, scope: string): Promise<Response> => {
    try {
      request.signal.throwIfAborted();
      const raw = new URL(request.url).searchParams.get("url") ?? "";
      let url = imageURL(raw);
      // Never keep provider query credentials as cache keys or error messages.
      const key = createHash("sha256").update(scope).update("\0").update(url.href).digest("hex");
      for (const [key, entry] of cache) if (entry.expires <= now()) remove(key);
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return response(hit); }
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? 10_000);
      const signal = AbortSignal.any([request.signal, deadline.signal]);
      let release: (() => void) | undefined;
      try {
        release = await acquire(signal);
        for (let hop = 0; hop <= 3; hop++) {
          signal.throwIfAborted();
          // Transport validates literal IPs AND every resolved answer at every hop.
          const result = await fetchImage(url.href, { signal });
          signal.throwIfAborted();
          if (REDIRECTS.has(result.status)) {
            const location = result.headers.get("location");
            await result.body?.cancel();
            if (!location || hop === 3) throw new Error("Invalid presentation image");
            url = imageURL(new URL(location, url).href);
            continue;
          }
          if (result.status !== 200 || result.headers.get("content-encoding") && result.headers.get("content-encoding") !== "identity") throw new Error("Invalid presentation image");
          const mime = result.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
          const bytes = new Uint8Array(await result.arrayBuffer());
          signal.throwIfAborted();
          if (bytes.length > IMAGE_BYTE_LIMIT) throw new Error("Invalid presentation image");
          rasterDimensions(bytes, mime);
          while (cache.size && (cost + bytes.byteLength > 16 * 1024 * 1024 || cache.size >= 64)) remove(cache.keys().next().value!);
          cache.set(key, { bytes, mime, expires: now() + 60_000 }); cost += bytes.byteLength;
          return response({ bytes, mime });
        }
        throw new Error("Invalid presentation image");
      } finally { clearTimeout(timer); release?.(); }
    } catch {
      // Do not echo/log upstream URLs, DNS answers, provider query tokens or errors.
      return new Response(null, { status: 422, headers: { "cache-control": "no-store" } });
    }
  };
}
const images = createPresentationImages();
export function presentationImageResponse(request: Request, sessionId: string | null, authMode: string, load = images): Promise<Response> {
  if (authMode === "required" && !sessionId) return Promise.resolve(new Response(null, { status: 401, headers: { "cache-control": "no-store" } }));
  return load(request, sessionId ?? "auth-disabled");
}
