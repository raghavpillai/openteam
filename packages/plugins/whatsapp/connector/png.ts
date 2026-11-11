import { deflateSync } from "node:zlib";
import qrcode from "qrcode-generator";

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

/** Lossless grayscale PNG; no browser, external renderer, or network service. */
export function grayscalePng(width: number, height: number, pixel: (x: number, y: number) => number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = pixel(x, y);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pairingPng(payload: string) {
  if (!payload || payload.length > 8192) throw new Error("Invalid WhatsApp QR payload");
  const qr = qrcode(0, "M");
  qr.addData(payload, "Byte");
  qr.make();
  // Keep a high-resolution integer grid for export and high-density displays.
  const count = qr.getModuleCount(), scale = 12, margin = 4;
  const size = (count + margin * 2) * scale;
  return grayscalePng(size, size, (x, y) => {
    const column = Math.floor(x / scale) - margin, row = Math.floor(y / scale) - margin;
    return row >= 0 && column >= 0 && row < count && column < count && qr.isDark(row, column) ? 0 : 255;
  });
}
