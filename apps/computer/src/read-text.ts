/** Recognize ordinary text without letting binary NULs enter model/DB output. */
export function decodeReadableText(bytes: Buffer): string | undefined {
  const utf16 = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le"
    : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : undefined;
  let text: string;
  try {
    if (utf16 && bytes.length % 2 !== 0) return;
    text = new TextDecoder(utf16 ?? "utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (utf16) return;
    // Common legacy text files use single-byte Latin-1/Windows-1252. Controls
    // remain binary; an invalid UTF-8 sequence alone is not proof of a binary file.
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(text) ? undefined : text;
}

/** The decoder for a large text file, judged from its first bytes; undefined when binary. */
export function readableTextEncoding(sample: Buffer): "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" | undefined {
  const utf16 = sample[0] === 255 && sample[1] === 254 ? "utf-16le"
    : sample[0] === 254 && sample[1] === 255 ? "utf-16be" : undefined;
  let text: string;
  let encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" = utf16 ?? "utf-8";
  try {
    // A sample can end inside a multibyte character; streaming mode tolerates that.
    text = new TextDecoder(encoding, { fatal: true }).decode(sample, { stream: true });
  } catch {
    if (utf16) return;
    encoding = "windows-1252";
    text = new TextDecoder(encoding).decode(sample);
  }
  return /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(text) ? undefined : encoding;
}

const IMAGE_SIGNATURES: Array<[string, (bytes: Buffer) => boolean]> = [
  ["image/png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ["image/gif", (bytes) => ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))],
  ["image/webp", (bytes) => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"],
];

/** Images are recognized by content first, so a misnamed or extensionless image still shows. */
export const sniffImageMimeType = (bytes: Buffer): string | undefined =>
  IMAGE_SIGNATURES.find(([, matches]) => matches(bytes))?.[0];
