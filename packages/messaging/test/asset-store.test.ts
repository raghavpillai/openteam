import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed attachment store", () => {
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
