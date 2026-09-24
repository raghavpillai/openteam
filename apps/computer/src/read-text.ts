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
