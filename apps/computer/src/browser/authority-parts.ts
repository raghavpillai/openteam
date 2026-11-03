import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { browserJsonChunks } from "./json-chunks";

/**
 * Array elements at least this large (localStorage entries, IndexedDB
 * databases, Cache Storage entries) are stored as their own encrypted part.
 * Sites rotate small cookies and storage keys while idle; keeping large,
 * mostly immutable data in separate content-addressed files means such a
 * change rewrites only the small index instead of every cached response.
 */
export const AUTHORITY_PART_MIN_BYTES = 16 * 1024;

export const PART_NAME = /^[a-f0-9]{64}$/;

export interface AuthorityPartReference {
  $part: string;
}

export const isAuthorityPartReference = (value: unknown): value is AuthorityPartReference => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const name = (value as { $part?: unknown }).$part;
  return keys.length === 1 && typeof name === "string" && PART_NAME.test(name);
};

/** Parts are named by a keyed hash so names reveal nothing without the key. */
export const authorityPartName = (key: Buffer, chunks: Iterable<string>): string => {
  const hmac = createHmac("sha256", key);
  for (const chunk of chunks) hmac.update(chunk, "utf8");
  return hmac.digest("hex");
};

/**
 * Replaces large array elements, innermost first, with part references. The
 * returned size is approximate (escapes are ignored); it only decides what
 * becomes a part.
 */
export function splitAuthorityParts(
  value: unknown,
  key: Buffer,
  parts: Map<string, unknown>,
  ancestors = new Set<object>()
): { value: unknown; size: number } {
  if (typeof value === "string") return { value, size: value.length + 2 };
  if (value === null || typeof value !== "object") return { value, size: 8 };
  if (ancestors.has(value)) throw new TypeError("Circular browser state");
  ancestors.add(value);
  try {
    return splitContainer(value, key, parts, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function splitContainer(
  value: object,
  key: Buffer,
  parts: Map<string, unknown>,
  ancestors: Set<object>
): { value: unknown; size: number } {
  if (Array.isArray(value)) {
    let size = 2;
    const items = value.map((item) => {
      const split = splitAuthorityParts(item, key, parts, ancestors);
      if (split.size < AUTHORITY_PART_MIN_BYTES) {
        size += split.size + 1;
        return split.value;
      }
      const name = authorityPartName(key, browserJsonChunks(split.value));
      parts.set(name, split.value);
      size += 76;
      return { $part: name } satisfies AuthorityPartReference;
    });
    return { value: items, size };
  }
  let size = 2;
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const split = splitAuthorityParts(item, key, parts, ancestors);
    result[field] = split.value;
    size += field.length + split.size + 4;
  }
  return { value: result, size };
}

/** Inverse of splitAuthorityParts. A missing or altered part rejects. */
export async function joinAuthorityParts(
  value: unknown,
  readPart: (name: string) => Promise<unknown>
): Promise<unknown> {
  if (value === null || typeof value !== "object") return value;
  if (isAuthorityPartReference(value)) {
    return joinAuthorityParts(await readPart(value.$part), readPart);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) items.push(await joinAuthorityParts(item, readPart));
    return items;
  }
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    result[field] = await joinAuthorityParts(item, readPart);
  }
  return result;
}

/**
 * Streams JSON chunks into the encrypted envelope read by readBrowserAuthority
 * and publishes it atomically. Staging happens in `stagingDirectory` so a
 * partially written file never appears inside a snapshotted directory.
 */
export async function writeEncryptedAuthority(
  path: string,
  chunks: Iterable<string>,
  key: Buffer,
  stagingDirectory: string,
  stagingName: string
): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const temporary = join(stagingDirectory, `${stagingName}.tmp-${randomBytes(6).toString("hex")}`);
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      // GCM's tag is available only after final(). Reserve its fixed-width
      // base64 slot, then patch it before atomic publication. No plaintext
      // reaches disk.
      const prefix = `{"iv":${JSON.stringify(iv.toString("base64"))},"tag":"`;
      await output.writeFile(`${prefix}${" ".repeat(24)}","data":"`);
      let carry: Buffer = Buffer.alloc(0);
      const append = async (encrypted: Buffer) => {
        const bytes = carry.length ? Buffer.concat([carry, encrypted]) : encrypted;
        const end = bytes.length - (bytes.length % 3);
        if (end) await output.writeFile(bytes.subarray(0, end).toString("base64"));
        carry = Buffer.from(bytes.subarray(end));
      };
      for (const chunk of chunks) await append(cipher.update(chunk, "utf8"));
      await append(cipher.final());
      if (carry.length) await output.writeFile(carry.toString("base64"));
      await output.writeFile('"}');
      const tag = Buffer.from(cipher.getAuthTag().toString("base64"));
      let offset = 0;
      while (offset < tag.length) {
        const { bytesWritten } = await output.write(
          tag, offset, tag.length - offset, Buffer.byteLength(prefix) + offset
        );
        if (!bytesWritten) throw new Error("Unable to write browser authority authentication tag");
        offset += bytesWritten;
      }
    } finally {
      await output.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
