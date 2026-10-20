import { createDecipheriv } from "node:crypto";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/**
 * Stream the ciphertext of our existing JSON envelope. Authentication finishes
 * before any plaintext is returned to the broker. JSON.parse still needs the
 * final plaintext string, but the complete base64 envelope and ciphertext no
 * longer coexist with it in memory.
 */
export async function readBrowserAuthority(path: string, key: Buffer): Promise<string> {
  const input = await open(path, "r");
  try {
    const legacy = async () => {
      // Positional reads below do not advance the file cursor.
      const packed = JSON.parse(await input.readFile("utf8")) as {
        iv: string; tag: string; data: string;
      };
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(packed.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(packed.data, "base64")), decipher.final(),
      ]).toString("utf8");
    };
    const prefix = Buffer.alloc(128);
    const { bytesRead } = await input.read(prefix, 0, prefix.length, 0);
    const match = prefix.subarray(0, bytesRead).toString("ascii").match(
      /^\{"iv":"([A-Za-z0-9+/]{16})","tag":"([A-Za-z0-9+/]{22}==)","data":"/
    );
    if (!match) {
      // Preserve compatibility with noncanonical JSON whitespace/key order.
      // Every envelope written by OpenTeam uses the streaming path above.
      return await legacy();
    }
    const size = (await input.stat()).size;
    const start = match[0].length;
    const end = size - 2;
    const suffix = Buffer.alloc(2);
    await input.read(suffix, 0, 2, end);
    if (end < start || (end - start) % 4 !== 0 || suffix.toString() !== '"}')
      return await legacy();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(match[1]!, "base64"));
    decipher.setAuthTag(Buffer.from(match[2]!, "base64"));
    const decoder = new StringDecoder("utf8");
    const parts: string[] = [];
    const buffer = Buffer.alloc(256 * 1024); // Base64 blocks must be multiples of four.
    for (let offset = start; offset < end;) {
      const length = Math.min(buffer.length, end - offset);
      let filled = 0;
      while (filled < length) {
        const result = await input.read(buffer, filled, length - filled, offset + filled);
        if (!result.bytesRead) throw new Error("Truncated browser authority");
        filled += result.bytesRead;
      }
      const encoded = buffer.subarray(0, length).toString("ascii");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return await legacy();
      const ciphertext = Buffer.from(encoded, "base64");
      parts.push(decoder.write(decipher.update(ciphertext)));
      offset += length;
    }
    parts.push(decoder.end(decipher.final()));
    return parts.join("");
  } finally {
    await input.close();
  }
}
