import { crc32, deflate } from "node:zlib";
import { promisify } from "node:util";

const deflateAsync = promisify(deflate);
const ROWS_PER_SLICE = 24;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Writes one PNG chunk into `out` at `offset`; the CRC runs over type then data, no copy. */
const writeChunk = (out: Buffer, offset: number, type: string, data: Uint8Array): number => {
  out.writeUInt32BE(data.byteLength, offset);
  out.write(type, offset + 4, "ascii");
  out.set(data, offset + 8);
  const crc = crc32(data, crc32(out.subarray(offset + 4, offset + 8)));
  out.writeUInt32BE(crc >>> 0, offset + 8 + data.byteLength);
  return offset + 12 + data.byteLength;
};

const EMPTY = new Uint8Array(0);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encodes a screen capture as an RGB PNG without blocking the main process. Electron's
 * `NativeImage.toPNG()` is synchronous (100 ms+ for one display), and the main thread being
 * busy can cost the overlay frames. Here rows are filtered in small slices that yield to the
 * event loop, and compression runs on libuv's thread pool.
 *
 * `pixels` is NativeImage.toBitmap(): 32-bit pixels, BGRA on macOS and Windows.
 */
export async function encodeScreenPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  order: "bgra" | "rgba" = "bgra",
  signal?: AbortSignal
): Promise<Buffer> {
  if (width <= 0 || height <= 0 || pixels.byteLength < width * height * 4) throw new Error("Screen capture is invalid");
  // Held in one place only, so it can be released before compression.
  let bitmap: Uint8Array | null = pixels;
  pixels = EMPTY;
  const stride = width * 4;
  const rowBytes = width * 3 + 1;
  const raw = Buffer.allocUnsafe(rowBytes * height);
  const [red, blue] = order === "bgra" ? [2, 0] : [0, 2];
  for (let top = 0; top < height; top += ROWS_PER_SLICE) {
    const bottom = Math.min(height, top + ROWS_PER_SLICE);
    for (let y = top; y < bottom; y += 1) {
      const row = y * stride;
      let target = y * rowBytes;
      // The "Sub" filter: each byte minus the same channel of the pixel to its left. Screens
      // are mostly flat color, so this compresses far better than unfiltered rows.
      raw[target++] = 1;
      let r0 = 0, g0 = 0, b0 = 0;
      for (let x = 0; x < width; x += 1) {
        const i = row + x * 4;
        const r = bitmap![i + red]!, g = bitmap![i + 1]!, b = bitmap![i + blue]!;
        raw[target++] = (r - r0) & 0xff;
        raw[target++] = (g - g0) & 0xff;
        raw[target++] = (b - b0) & 0xff;
        r0 = r; g0 = g; b0 = b;
      }
    }
    await yieldToEventLoop();
    // A shot that was closed or retaken stops encoding at the next slice.
    if (signal?.aborted) throw new Error("Screen capture encode cancelled");
  }
  // The raw pixels can be collected while compression runs.
  bitmap = null;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB: a screen is opaque
  const idat = await deflateAsync(raw, { level: 6 });
  if (signal?.aborted) throw new Error("Screen capture encode cancelled");
  const out = Buffer.allocUnsafe(SIGNATURE.length + 25 + 12 + idat.byteLength + 12);
  SIGNATURE.copy(out, 0);
  let offset = writeChunk(out, SIGNATURE.length, "IHDR", header);
  offset = writeChunk(out, offset, "IDAT", idat);
  writeChunk(out, offset, "IEND", new Uint8Array(0));
  return out;
}
