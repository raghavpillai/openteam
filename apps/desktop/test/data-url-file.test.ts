import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBytesFully, writeDataUrlToFileAtomically } from "../src/main/data-url-file";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-data-url-file-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      })
    )
  );
});

describe("bounded data URL image saves", () => {
  test("retries partial writes until the complete chunk is durable", async () => {
    const output: number[] = [];
    const writer = {
      write: async (bytes: Uint8Array, offset: number, length: number) => {
        const bytesWritten = Math.min(2, length);
        output.push(...bytes.subarray(offset, offset + bytesWritten));
        return { bytesWritten, buffer: bytes };
      },
    };
    await writeBytesFully(writer as never, new Uint8Array([1, 2, 3, 4, 5]));
    expect(output).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects a writer that cannot make progress", async () => {
    const writer = {
      write: async (bytes: Uint8Array) => ({ bytesWritten: 0, buffer: bytes }),
    };
    await expect(writeBytesFully(writer as never, new Uint8Array([1]))).rejects.toThrow(
      "File write made no progress"
    );
  });

  test("streams permissive base64 to exact private output across quantum boundaries", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "image.png");
    const original = Buffer.from(
      Array.from({ length: 4_097 }, (_, index) => (index * 29 + 7) % 256)
    );
    const payload = original.toString("base64url").replace(/.{5}/g, (value) => `${value}! \n`);

    const result = await writeDataUrlToFileAtomically(
      `data:image/png;charset=utf-8;base64,${payload}`,
      destination,
      { inputChunkCharacters: 7 }
    );

    expect(await readFile(destination)).toEqual(Buffer.from(payload, "base64"));
    expect(await readFile(destination)).toEqual(original);
    expect(result.bytesWritten).toBe(original.byteLength);
    expect(result.largestChunkBytes).toBeLessThanOrEqual(6);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["image.png"]);
  });

  test("streams percent escapes with decodeURIComponent-compatible UTF-8 semantics", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "image.svg");
    const payload = `header%20%E2%82%AC-${"😀".repeat(20)}%00tail`;

    const result = await writeDataUrlToFileAtomically(
      `data:image/svg+xml;charset=utf-8,${payload}`,
      destination,
      { inputChunkCharacters: 4, percentChunkBytes: 1 }
    );

    const expected = Buffer.from(decodeURIComponent(payload), "utf8");
    expect(await readFile(destination)).toEqual(expected);
    expect(result.bytesWritten).toBe(expected.byteLength);
    expect(result.largestChunkBytes).toBeLessThanOrEqual(8);
  });

  test("retains the existing case-sensitive base64 metadata behavior", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "uppercase-marker.png");

    await writeDataUrlToFileAtomically("data:image/png;BASE64,YQ==", destination);

    expect(await readFile(destination, "utf8")).toBe("YQ==");
  });

  test("leaves an existing destination untouched and removes temp files on limit errors", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "image.png");
    await writeFile(destination, "original", { mode: 0o644 });
    const source = `data:image/png;base64,${Buffer.alloc(40, 0xab).toString("base64")}`;

    await expect(
      writeDataUrlToFileAtomically(source, destination, {
        maxBytes: 12,
        inputChunkCharacters: 8,
      })
    ).rejects.toThrow("Image exceeds 100 MiB");

    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["image.png"]);
  });

  test("cleans partial output for malformed percent input and aborts", async () => {
    const directory = await temporaryDirectory();
    const malformedDestination = join(directory, "malformed.svg");
    await expect(
      writeDataUrlToFileAtomically("data:image/svg+xml,valid%20prefix%E2", malformedDestination, {
        percentChunkBytes: 1,
      })
    ).rejects.toBeInstanceOf(URIError);

    const abortedDestination = join(directory, "aborted.png");
    const controller = new AbortController();
    const source = `data:image/png;base64,${Buffer.alloc(128, 0xcd).toString("base64")}`;
    await expect(
      writeDataUrlToFileAtomically(source, abortedDestination, {
        signal: controller.signal,
        inputChunkCharacters: 8,
        onProgress: () => controller.abort(),
      })
    ).rejects.toThrow();

    expect(await readdir(directory)).toEqual([]);
  });

  test("atomically replaces a destination only after complete decoding", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "image.gif");
    await writeFile(destination, "old");
    const expected = Buffer.from("GIF89a\0streamed");

    await writeDataUrlToFileAtomically(
      `data:image/gif;base64,${expected.toString("base64")}`,
      destination,
      { inputChunkCharacters: 5, maxBytes: expected.byteLength }
    );

    expect(await readFile(destination)).toEqual(expected);
    expect(await readdir(directory)).toEqual(["image.gif"]);
  });
});
