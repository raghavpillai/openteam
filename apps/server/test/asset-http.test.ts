import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "@openteam/messaging";
import { assetResponse } from "../src/asset-http";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temp = async (prefix: string) => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };
const fixture = async () => {
  const root = await temp("openteam-asset-http-");
  const assets = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
  const ref = await assets.ingestBytes({ fileName: "report.txt", mimeType: "text/plain", bytes: Buffer.from("0123456789") });
  let fallbackLookups = 0;
  const get = (query = "", init?: RequestInit) => {
    const url = new URL(`http://openteam.test/api/v0/assets/${ref.assetId}${query}`);
    return assetResponse(assets, { agentAttachmentPath: async () => { fallbackLookups++; return null; } }, new Request(url, init), url, ref.assetId);
  };
  return { get, assetId: ref.assetId, fallbackLookups: () => fallbackLookups };
};

test("serves immutable content with a sanitized inline filename and locked-down headers", async () => {
  const f = await fixture();
  const response = await f.get("?name=../report.txt");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("0123456789");
  expect(Object.fromEntries(["content-type", "content-length", "x-content-type-options", "content-security-policy", "cross-origin-resource-policy"].map(name => [name, response.headers.get(name)]))).toEqual({
    "content-type": "text/plain; charset=utf-8", "content-length": "10", "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'", "cross-origin-resource-policy": "same-origin",
  });
  expect(response.headers.get("content-disposition")).toContain('inline; filename="report.txt"');
  expect(response.headers.get("etag")).toBe(`"${f.assetId}"`);
  expect(f.fallbackLookups()).toBe(0);
});

test("supports exact, suffix and HEAD ranges and rejects malformed or out-of-bounds ones", async () => {
  const f = await fixture();
  const exact = await f.get("", { headers: { range: "bytes=2-5" } });
  expect(exact.status).toBe(206);
  expect(exact.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(await exact.text()).toBe("2345");
  expect(await (await f.get("", { headers: { range: "bytes=-3" } })).text()).toBe("789");
  const head = await f.get("", { method: "HEAD", headers: { range: "bytes=4-" } });
  expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([206, "6", ""]);
  for (const range of ["bytes=", "bytes=10-12", "bytes=7-2", "bytes=0-1,4-5"]) {
    const response = await f.get("?download=1", { headers: { range } });
    expect([response.status, response.headers.get("content-range")]).toEqual([416, "bytes */10"]);
  }
});

test("serves the agent-local attachment after staging metadata is gone", async () => {
  const root = await temp("openteam-agent-attachment-http-");
  const bytes = Buffer.from("agent-local-authority");
  const assetId = createHash("sha256").update(bytes).digest("hex");
  const path = join(root, `${assetId}.txt`);
  await writeFile(path, bytes);
  const url = new URL(`http://openteam.test/api/v0/assets/${assetId}?name=local.txt`);
  const response = await assetResponse(new AssetStore({ root: join(root, "empty-staging"), allowedFileRoots: [root] }), { agentAttachmentPath: async () => path }, new Request(url), url, assetId);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("agent-local-authority");
  expect(response.headers.get("content-type")).toContain("text/plain");
});
