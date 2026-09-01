import { type FileHandle, open, rename, unlink } from "node:fs/promises";

export const MAX_IMAGE_SAVE_BYTES = 100 * 1024 * 1024;

const INPUT_CHUNK_CHARACTERS = 256 * 1024;
const PERCENT_CHUNK_BYTES = 64 * 1024;
const BASE64_NON_ALPHABET = /[^A-Za-z0-9+/_-]/g;

export interface DataUrlWriteProgress {
  bytesWritten: number;
  chunkBytes: number;
}

export interface DataUrlWriteOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  inputChunkCharacters?: number;
  percentChunkBytes?: number;
  onProgress?: (progress: DataUrlWriteProgress) => void;
}

export interface DataUrlWriteResult {
  bytesWritten: number;
  largestChunkBytes: number;
}

const yieldToEventLoop = () => new Promise<void>((resolveYield) => setImmediate(resolveYield));

const hexNibble = (code: number): number => {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
};

const uriError = (): never => {
  throw new URIError("URI malformed");
};

type ByteWriter = Pick<FileHandle, "write">;

export const writeBytesFully = async (
  file: ByteWriter,
  bytes: Uint8Array,
  signal?: AbortSignal
) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    signal?.throwIfAborted();
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("File write made no progress");
    offset += result.bytesWritten;
  }
};

const validatePercentBytes = (decoder: TextDecoder, bytes: Uint8Array, stream: boolean): void => {
  try {
    decoder.decode(bytes, { stream });
  } catch {
    uriError();
  }
};

/**
 * Incrementally decodes one data URL into an owned sibling temporary file and
 * atomically renames it over the destination only after complete validation.
 */
export const writeDataUrlToFileAtomically = async (
  sourceUrl: string,
  destination: string,
  options: DataUrlWriteOptions = {}
): Promise<DataUrlWriteResult> => {
  const separator = sourceUrl.indexOf(",");
  if (!sourceUrl.startsWith("data:") || separator < 0) {
    throw new Error("Invalid image data URL");
  }
  const maxBytes = options.maxBytes ?? MAX_IMAGE_SAVE_BYTES;
  const inputChunkCharacters = Math.max(
    4,
    Math.floor(options.inputChunkCharacters ?? INPUT_CHUNK_CHARACTERS)
  );
  const percentChunkBytes = Math.max(
    1,
    Math.floor(options.percentChunkBytes ?? PERCENT_CHUNK_BYTES)
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Image save byte limit must be a non-negative safe integer");
  }
  if (!Number.isFinite(inputChunkCharacters) || !Number.isFinite(percentChunkBytes)) {
    throw new Error("Image save chunk sizes must be finite");
  }

  const metadata = sourceUrl.slice(5, separator);
  const base64 = metadata.split(";").includes("base64");
  const payloadStart = separator + 1;
  const temporary = `${destination}.openbot-${crypto.randomUUID()}.tmp`;
  let file: FileHandle | null = null;
  let temporaryOwned = false;
  let bytesWritten = 0;
  let largestChunkBytes = 0;

  const append = async (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    options.signal?.throwIfAborted();
    if (bytesWritten + bytes.byteLength > maxBytes) throw new Error("Image exceeds 100 MiB");
    if (!file) throw new Error("Image temporary file is not open");
    await writeBytesFully(file, bytes, options.signal);
    bytesWritten += bytes.byteLength;
    largestChunkBytes = Math.max(largestChunkBytes, bytes.byteLength);
    options.onProgress?.({ bytesWritten, chunkBytes: bytes.byteLength });
  };

  try {
    options.signal?.throwIfAborted();
    file = await open(temporary, "wx", 0o600);
    temporaryOwned = true;
    if (base64) {
      const decoded = Buffer.allocUnsafe(Math.ceil(((inputChunkCharacters + 3) * 3) / 4));
      let carry = "";
      let ended = false;
      const decodeAndAppend = async (encoded: string) => {
        const decodedLength = decoded.write(encoded, 0, decoded.byteLength, "base64");
        await append(decoded.subarray(0, decodedLength));
      };
      for (let index = payloadStart; index < sourceUrl.length && !ended; ) {
        const end = Math.min(sourceUrl.length, index + inputChunkCharacters);
        let input = sourceUrl.slice(index, end);
        index = end;
        const padding = input.indexOf("=");
        if (padding >= 0) {
          input = input.slice(0, padding);
          ended = true;
        }
        const significant = carry + input.replace(BASE64_NON_ALPHABET, "");
        const completeLength = ended
          ? significant.length
          : significant.length - (significant.length % 4);
        await decodeAndAppend(significant.slice(0, completeLength));
        carry = significant.slice(completeLength);
        await yieldToEventLoop();
      }
      if (!ended && carry) await decodeAndAppend(carry);
    } else {
      const percentBytes = new Uint8Array(percentChunkBytes);
      const rawBytes = Buffer.allocUnsafe(inputChunkCharacters * 3);
      let index = payloadStart;
      while (index < sourceUrl.length) {
        options.signal?.throwIfAborted();
        if (sourceUrl.charCodeAt(index) === 37) {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          while (index < sourceUrl.length && sourceUrl.charCodeAt(index) === 37) {
            let count = 0;
            while (
              count < percentBytes.byteLength &&
              index < sourceUrl.length &&
              sourceUrl.charCodeAt(index) === 37
            ) {
              if (index + 2 >= sourceUrl.length) uriError();
              const high = hexNibble(sourceUrl.charCodeAt(index + 1));
              const low = hexNibble(sourceUrl.charCodeAt(index + 2));
              if (high < 0 || low < 0) uriError();
              percentBytes[count] = (high << 4) | low;
              count += 1;
              index += 3;
            }
            const continues = index < sourceUrl.length && sourceUrl.charCodeAt(index) === 37;
            const chunk = percentBytes.subarray(0, count);
            validatePercentBytes(decoder, chunk, continues);
            await append(chunk);
            await yieldToEventLoop();
          }
          continue;
        }

        const nextPercent = sourceUrl.indexOf("%", index);
        let end = Math.min(
          nextPercent < 0 ? sourceUrl.length : nextPercent,
          index + inputChunkCharacters
        );
        if (
          end < sourceUrl.length &&
          end > index &&
          sourceUrl.charCodeAt(end - 1) >= 0xd800 &&
          sourceUrl.charCodeAt(end - 1) <= 0xdbff &&
          sourceUrl.charCodeAt(end) >= 0xdc00 &&
          sourceUrl.charCodeAt(end) <= 0xdfff
        ) {
          end -= 1;
        }
        const encodedLength = rawBytes.write(
          sourceUrl.slice(index, end),
          0,
          rawBytes.byteLength,
          "utf8"
        );
        await append(rawBytes.subarray(0, encodedLength));
        index = end;
        await yieldToEventLoop();
      }
    }

    options.signal?.throwIfAborted();
    await file.close();
    file = null;
    await rename(temporary, destination);
    temporaryOwned = false;
    return { bytesWritten, largestChunkBytes };
  } catch (error) {
    await file?.close().catch(() => undefined);
    if (temporaryOwned) await unlink(temporary).catch(() => undefined);
    throw error;
  }
};
