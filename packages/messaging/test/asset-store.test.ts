import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AssetStore } from "../src";

const roots: string[] = [];

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-assets-"));
  roots.push(root);
  return root;
};

const png = () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(3, 16);
  bytes.writeUInt32BE(2, 20);
  return bytes;
};

const chunkedStream = (bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed attachment store", () => {
  test("ingests real Bun HTTP request streams and cleans failed staging", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const failures: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (!request.body) return new Response(null, { status: 400 });
        try {
          return Response.json(
            await store.ingestStream({
              fileName: request.headers.get("x-file-name") ?? "upload.bin",
              mimeType: request.headers.get("content-type") ?? undefined,
              stream: request.body,
            }),
            { status: 201 }
          );
        } catch (error) {
          failures.push(error);
          return Response.json({ error: "rejected" }, { status: 422 });
        }
      },
    });

    try {
      const bytes = Buffer.from("native Bun upload\n".repeat(16_384));
      const uploaded = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-file-name": "native-upload.txt" },
        body: bytes,
      });
      expect(uploaded.status).toBe(201);
      expect(await uploaded.json()).toEqual({
        assetId: createHash("sha256").update(bytes).digest("hex"),
        fileName: "native-upload.txt",
        mimeType: "text/plain",
        byteSize: bytes.byteLength,
        kind: "text",
      });
      expect(
        await readFile(store.contentPath(createHash("sha256").update(bytes).digest("hex")))
      ).toEqual(bytes);

      const rejected = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-file-name": "oversized.txt" },
        body: Buffer.alloc(25 * 1024 * 1024 + 1),
      });
      expect(rejected.status).toBe(422);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: "asset_too_large" });
      expect((await readdir(assetRoot)).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("streams split headers and preserves JPEG dimensions beyond the classification prefix", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const jpeg = Buffer.alloc(8_520);
    jpeg.set([0xff, 0xd8, 0xff, 0xe1, 0x21, 0x34], 0);
    jpeg.set([0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x25, 0x00, 0x31], 8_504);

    const ref = await store.ingestStream({
      fileName: "large-metadata.jpg",
      mimeType: "application/octet-stream",
      stream: chunkedStream(jpeg, 257),
      alt: "JPEG dimensions",
    });

    expect(ref).toEqual({
      assetId: createHash("sha256").update(jpeg).digest("hex"),
      fileName: "large-metadata.jpg",
      mimeType: "image/jpeg",
      byteSize: jpeg.byteLength,
      kind: "image",
      width: 49,
      height: 37,
      alt: "JPEG dimensions",
    });
    expect(await readFile(store.contentPath(ref.assetId))).toEqual(jpeg);
    expect((await readdir(join(root, "assets"))).filter((name) => name.includes(".tmp"))).toEqual(
      []
    );
  });

  test("atomically deduplicates concurrent streamed uploads without temporary leftovers", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 13, 0x61);

    const refs = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        store.ingestStream({
          fileName: `copy-${index}.txt`,
          mimeType: "text/plain",
          stream: chunkedStream(bytes, 64 * 1024),
        })
      )
    );

    expect(new Set(refs.map(({ assetId }) => assetId)).size).toBe(1);
    expect((await readdir(assetRoot)).sort()).toEqual([
      `${refs[0]?.assetId}.blob`,
      `${refs[0]?.assetId}.json`,
    ]);
  });

  test("streams allowed file and remote sources through the same content-addressed path", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.txt");
    const bytes = Buffer.from("streamed source\n".repeat(100_000));
    await writeFile(source, bytes);
    const remotePng = png();
    let fetches = 0;
    const store = new AssetStore({
      root: join(root, "assets"),
      allowedFileRoots: [root],
      fetch: (async () => {
        fetches += 1;
        return new Response(chunkedStream(remotePng, 3), {
          headers: {
            "content-length": String(remotePng.byteLength),
            "content-type": "image/png",
          },
        });
      }) as unknown as typeof fetch,
    });

    const fileRef = await store.ingestSource({ url: pathToFileURL(source).toString() });
    const remoteRef = await store.ingestSource({
      url: "https://8.8.8.8/remote.png",
      alt: "Remote",
    });

    expect(fileRef).toMatchObject({
      assetId: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      kind: "text",
    });
    expect(remoteRef).toMatchObject({ kind: "image", width: 3, height: 2, alt: "Remote" });
    expect(fetches).toBe(1);
  });

  test("cancels oversized and aborted streams and removes owned temporary files", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    let oversizedCanceled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        oversizedCanceled = true;
      },
    });

    await expect(
      store.ingestStream({ fileName: "oversized.txt", stream: oversized })
    ).rejects.toMatchObject({ code: "asset_too_large" });
    expect(emitted).toBeGreaterThanOrEqual(26);
    expect(emitted).toBeLessThanOrEqual(27);
    expect(oversizedCanceled).toBeTrue();
    expect(await readdir(assetRoot)).toEqual([]);

    const abort = new AbortController();
    let markPullStarted: (() => void) | null = null;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    let abortedCanceled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        markPullStarted?.();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        abortedCanceled = true;
      },
    });
    const pending = store.ingestStream({
      fileName: "aborted.txt",
      stream: stalled,
      signal: abort.signal,
    });
    await pullStarted;
    abort.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow("client disconnected");
    expect(abortedCanceled).toBeTrue();
    expect(await readdir(assetRoot)).toEqual([]);
  });

  test("deduplicates bytes and rebuilds trusted metadata from the store", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const first = await store.ingestBytes({
      fileName: "first.png",
      mimeType: "application/octet-stream",
      bytes: png(),
      alt: "First image",
    });
    const second = await store.ingestBytes({ fileName: "second.png", bytes: png() });

    expect(second.assetId).toBe(first.assetId);
    expect(first).toMatchObject({
      mimeType: "image/png",
      byteSize: 24,
      kind: "image",
      width: 3,
      height: 2,
    });
    expect(
      await store.normalizeRefs([
        {
          ...first,
          fileName: "renamed.png",
          mimeType: "text/html",
          byteSize: 1,
          kind: "file",
        },
      ])
    ).toEqual([{ ...first, fileName: "renamed.png" }]);
    expect(await readFile(store.contentPath(first.assetId))).toEqual(png());
    expect(await store.runtimeImages([first])).toEqual([
      { url: `data:image/png;base64,${png().toString("base64")}`, alt: "First image" },
    ]);
  });

  test("keeps runtime image order, filtering, and data URL semantics", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const firstBytes = png();
    const secondBytes = png();
    secondBytes.writeUInt32BE(7, 16);
    const [first, file, second] = await Promise.all([
      store.ingestBytes({ fileName: "first.png", bytes: firstBytes, alt: "First" }),
      store.ingestBytes({ fileName: "notes.txt", bytes: Buffer.from("not an image") }),
      store.ingestBytes({ fileName: "second.png", bytes: secondBytes }),
    ]);

    expect(await store.runtimeImages([first, file, second])).toEqual([
      { url: `data:image/png;base64,${firstBytes.toString("base64")}`, alt: "First" },
      { url: `data:image/png;base64,${secondBytes.toString("base64")}` },
    ]);
  });

  test("normalizes agent data URLs immediately instead of persisting inline bytes", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const ref = await store.ingestSource({
      url: `data:image/png;base64,${png().toString("base64")}`,
      alt: "Inline agent image",
    });

    expect(ref).toMatchObject({ kind: "image", mimeType: "image/png", alt: "Inline agent image" });
    expect(JSON.stringify(ref)).not.toContain("base64");
    expect(JSON.stringify(ref)).not.toContain("data:image");
  });

  test("downgrades active text MIME types before same-origin serving", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const ref = await store.ingestBytes({
      fileName: "page.html",
      mimeType: "text/html",
      bytes: Buffer.from("<script>top.location='https://attacker.invalid'</script>"),
    });

    expect(ref).toMatchObject({ kind: "text", mimeType: "text/plain" });
  });

  test("refuses to serve bytes that no longer match their content address", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const ref = await store.ingestBytes({ fileName: "note.txt", bytes: Buffer.from("trusted") });
    await writeFile(join(assetRoot, `${ref.assetId}.blob`), "changed");

    await expect(
      new AssetStore({ root: assetRoot, allowedFileRoots: [root] }).metadata(ref.assetId)
    ).rejects.toMatchObject({ code: "asset_corrupt" });
  });

  test("rejects unsafe names, invalid base64, private URLs, and file-root escapes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = new AssetStore({
      root: join(root, "assets"),
      allowedFileRoots: [join(root, "allowed")],
      fetch: (() => {
        throw new Error("private URL must be rejected before fetch");
      }) as unknown as typeof fetch,
    });
    await writeFile(join(outside, "secret.txt"), "secret");

    await expect(
      store.ingestBytes({ fileName: "../escape.txt", bytes: Buffer.from("x") })
    ).rejects.toMatchObject({ code: "invalid_asset_filename" });
    expect(() => store.decodeUpload({ fileName: "bad.txt", bytesBase64: "%%%=" })).toThrow();
    await expect(
      store.ingestSource({ url: "https://127.0.0.1/private.png" })
    ).rejects.toMatchObject({ code: "private_asset_url" });
    await expect(
      store.ingestSource({ url: pathToFileURL(join(outside, "secret.txt")).toString() })
    ).rejects.toMatchObject({ code: "asset_path_outside_store" });
  });

  test("resolves symlinks before accepting file sources", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const allowed = join(root, "allowed");
    await mkdir(allowed, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(allowed, "link.txt"));
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [allowed] });

    await expect(
      store.ingestSource({ url: pathToFileURL(join(allowed, "link.txt")).toString() })
    ).rejects.toMatchObject({ code: "asset_path_outside_store" });
  });

  test("prunes only unreferenced assets after the recovery grace period", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const retained = await store.ingestBytes({ fileName: "keep.txt", bytes: Buffer.from("keep") });
    const stale = await store.ingestBytes({ fileName: "stale.txt", bytes: Buffer.from("stale") });
    const old = new Date(Date.now() - 60_000);
    await Promise.all([
      utimes(join(assetRoot, `${stale.assetId}.blob`), old, old),
      utimes(join(assetRoot, `${stale.assetId}.json`), old, old),
    ]);

    expect(await store.prune(new Set([retained.assetId]), 1_000)).toBe(1);
    await expect(store.metadata(stale.assetId)).rejects.toMatchObject({ code: "asset_not_found" });
    expect(await store.metadata(retained.assetId)).toMatchObject({ assetId: retained.assetId });
  });
});
