import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_TURN_INLINE_IMAGE_BYTES, MAX_TURN_INLINE_IMAGES } from "@openteam/contracts";
import { AssetStore } from "../src";

const roots: string[] = [];

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-assets-"));
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
  test("cancels oversized and aborted streams and removes owned temporary files", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    let oversizedCanceled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) { emitted += 1; controller.enqueue(chunk); },
      cancel() { oversizedCanceled = true; },
    });
    await expect(store.ingestStream({ fileName: "oversized.txt", stream: oversized })).rejects.toMatchObject({ code: "asset_too_large" });
    expect(emitted).toBeGreaterThanOrEqual(26);
    expect(emitted).toBeLessThanOrEqual(27);
    expect(oversizedCanceled).toBeTrue();
    expect(await readdir(assetRoot)).toEqual([]);

    const abort = new AbortController();
    let markPullStarted: (() => void) | null = null;
    const pullStarted = new Promise<void>((resolve) => { markPullStarted = resolve; });
    let abortedCanceled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() { markPullStarted?.(); return new Promise<void>(() => undefined); },
      cancel() { abortedCanceled = true; },
    });
    const pending = store.ingestStream({ fileName: "aborted.txt", stream: stalled, signal: abort.signal });
    await pullStarted;
    abort.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow("client disconnected");
    expect(abortedCanceled).toBeTrue();
    expect(await readdir(assetRoot)).toEqual([]);
  });

  test("deduplicates bytes and rebuilds trusted metadata from the store", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const first = await store.ingestBytes({ fileName: "first.png", mimeType: "application/octet-stream", bytes: png(), alt: "First image" });
    const second = await store.ingestBytes({ fileName: "second.png", bytes: png() });

    expect(second.assetId).toBe(first.assetId);
    expect(first).toMatchObject({ mimeType: "image/png", byteSize: 24, kind: "image", width: 3, height: 2 });
    // Client-supplied metadata is untrusted; only the name survives.
    expect(await store.normalizeRefs([{ ...first, fileName: "renamed.png", mimeType: "text/html", byteSize: 1, kind: "file" }]))
      .toEqual([{ ...first, fileName: "renamed.png" }]);
    expect(await readFile(store.contentPath(first.assetId))).toEqual(png());
    expect(await store.runtimeImages([first])).toEqual([{ url: `data:image/png;base64,${png().toString("base64")}`, alt: "First image" }]);
  });

  test("shares one budget across the messages sent in one request", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const size = 24 * 1024 * 1024;
    const image = (index: number) => {
      const bytes = Buffer.alloc(size);
      png().copy(bytes);
      bytes.writeUInt32BE(index + 2, 16);
      return store.ingestBytes({ fileName: `big-${index}.png`, bytes });
    };
    const [a, b, c, d] = await Promise.all([0, 1, 2, 3].map(image));
    // Two replayed messages of two 24 MiB photos each: alone each fits, together the
    // request would carry four, so the second message gets only what's left.
    const budget = { images: MAX_TURN_INLINE_IMAGES, bytes: MAX_TURN_INLINE_IMAGE_BYTES };
    expect((await store.runtimeImages([a!, b!], budget)).length).toBe(2);
    expect((await store.runtimeImages([c!, d!], budget)).length).toBe(Math.floor(MAX_TURN_INLINE_IMAGE_BYTES / size) - 2);
    expect((await store.runtimeImages([c!, d!])).length).toBe(2);
  });

  test("downgrades active text MIME types before same-origin serving", async () => {
    const root = await temporaryRoot();
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const ref = await store.ingestBytes({ fileName: "page.html", mimeType: "text/html", bytes: Buffer.from("<script>top.location='https://attacker.invalid'</script>") });
    expect(ref).toMatchObject({ kind: "text", mimeType: "text/plain" });
  });

  test("refuses to serve bytes that no longer match their content address", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "assets");
    const store = new AssetStore({ root: assetRoot, allowedFileRoots: [root] });
    const ref = await store.ingestBytes({ fileName: "note.txt", bytes: Buffer.from("trusted") });
    await writeFile(join(assetRoot, `${ref.assetId}.blob`), "changed");

    await expect(new AssetStore({ root: assetRoot, allowedFileRoots: [root] }).metadata(ref.assetId)).rejects.toMatchObject({ code: "asset_corrupt" });
  });

  test("rejects unsafe names, invalid base64, private URLs, and file-root escapes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = new AssetStore({
      root: join(root, "assets"),
      allowedFileRoots: [join(root, "allowed")],
      fetch: (() => { throw new Error("private URL must be rejected before fetch"); }) as unknown as typeof fetch,
    });
    await writeFile(join(outside, "secret.txt"), "secret");

    await expect(store.ingestBytes({ fileName: "../escape.txt", bytes: Buffer.from("x") })).rejects.toMatchObject({ code: "invalid_asset_filename" });
    expect(() => store.decodeUpload({ fileName: "bad.txt", bytesBase64: "%%%=" })).toThrow();
    await expect(store.ingestSource({ url: "https://127.0.0.1/private.png" })).rejects.toMatchObject({ code: "private_asset_url" });
    await expect(store.ingestSource({ url: pathToFileURL(join(outside, "secret.txt")).toString() })).rejects.toMatchObject({ code: "asset_path_outside_store" });
    // A missing file inside an allowed root is named as missing, not as outside the store.
    await mkdir(join(root, "allowed"));
    await expect(store.ingestSource({ url: pathToFileURL(join(root, "allowed", "nope.pdf")).toString() })).rejects.toMatchObject({
      code: "attachment_missing",
      message: `No file at ${join(root, "allowed", "nope.pdf")} on your box, so nothing was sent. Attachments come from the box. For a file on one of the user's computers, copy it to the box with CopyToBox and attach the box path it returns; otherwise check the path and send again.`,
    });
    await expect(store.ingestSource({ url: pathToFileURL(join(outside, "nope.pdf")).toString() })).rejects.toMatchObject({ code: "asset_path_outside_store" });
    await writeFile(join(root, "allowed", "big.pdf"), "");
    await truncate(join(root, "allowed", "big.pdf"), 26_214_401);
    await expect(store.ingestSource({ url: pathToFileURL(join(root, "allowed", "big.pdf")).toString() })).rejects.toMatchObject({
      code: "asset_too_large",
      message: "big.pdf is over the 25 MB attachment limit, so nothing was sent. Compress, shrink, or split it on the box and attach the smaller file.",
    });
  });

  test("resolves symlinks before accepting file sources", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const allowed = join(root, "allowed");
    await mkdir(allowed, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(allowed, "link.txt"));
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [allowed] });

    await expect(store.ingestSource({ url: pathToFileURL(join(allowed, "link.txt")).toString() })).rejects.toMatchObject({ code: "asset_path_outside_store" });
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

  test("file sources may read ordinary agent files but never private state, even through a symlink", async () => {
    const root = await temporaryRoot();
    const state = join(root, "state");
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root], agentDataRoot: state });
    for (const relative of ["accessqa/public.txt", "agents/bot/accessqa/store.db", "agents/bot/store.db", "agents/bot/store.db-wal", "settings.json", "transcription.json", "connector-secrets/test.json", ".openteam/marker.json"]) {
      const path = join(state, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "harmless test fixture");
      if (relative.includes("accessqa/")) expect((await store.ingestSource({ url: pathToFileURL(path).href })).byteSize).toBeGreaterThan(0);
      else await expect(store.ingestSource({ url: pathToFileURL(path).href })).rejects.toMatchObject({ code: "asset_path_protected" });
    }
    await symlink(join(state, "settings.json"), join(root, "innocent.txt"));
    await expect(store.ingestSource({ url: pathToFileURL(join(root, "innocent.txt")).href })).rejects.toMatchObject({ code: "asset_path_protected" });
  });

  // A subprocess is essential: a promise rejection alone misses fatal unhandled
  // ReadStream errors, even when Bun also executes the surrounding catch.
  test.skipIf(process.getuid?.() === 0)("an unreadable file source fails without killing the process; later deliveries succeed", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "denied.txt"), "harmless");
    await chmod(join(root, "denied.txt"), 0);
    await writeFile(join(root, "ok.txt"), "readable");
    await writeFile(join(root, "probe.ts"), `
      import { AssetStore } from ${JSON.stringify(new URL("../src/asset-store.ts", import.meta.url).pathname)};
      const store = new AssetStore({root:${JSON.stringify(join(root, "assets"))},allowedFileRoots:[${JSON.stringify(root)}]});
      for(let attempt=0;attempt<3;attempt++) {
        try { await store.ingestSource({url:${JSON.stringify(pathToFileURL(join(root, "denied.txt")).href)}}); throw new Error("unexpected success"); }
        catch(e) { if(e.code!=="asset_file_unreadable") throw e; }
        const result=await store.ingestSource({url:${JSON.stringify(pathToFileURL(join(root, "ok.txt")).href)}});
        if(result.byteSize!==8) throw new Error("subsequent delivery failed");
      }
      console.log("RECOVERED_THREE_TIMES");
    `);
    const child = Bun.spawn([process.execPath, join(root, "probe.ts")], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("RECOVERED_THREE_TIMES");
    expect((await readdir(join(root, "assets"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
