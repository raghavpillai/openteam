import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "@openbot/messaging";
import { assetResponse } from "../src/asset-http";

const roots: string[] = [];
const noAgentAttachment = { agentAttachmentPath: async () => null };

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-asset-http-"));
  roots.push(root);
  const assets = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
  const ref = await assets.ingestBytes({
    fileName: "report.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("0123456789"),
  });
  return { assets, ref };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded asset HTTP responses", () => {
  test("serves immutable content with a sanitized inline filename", async () => {
    const { assets, ref } = await fixture();
    const url = new URL(`http://openbot.test/api/v0/assets/${ref.assetId}?name=../report.txt`);
    const response = await assetResponse(
      assets,
      noAgentAttachment,
      new Request(url),
      url,
      ref.assetId
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-disposition")).toContain('inline; filename="report.txt"');
    expect(response.headers.get("etag")).toBe(`"${ref.assetId}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("supports exact, suffix, and HEAD ranges", async () => {
    const { assets, ref } = await fixture();
    const url = new URL(`http://openbot.test/api/v0/assets/${ref.assetId}`);
    const exact = await assetResponse(
      assets,
      noAgentAttachment,
      new Request(url, { headers: { range: "bytes=2-5" } }),
      url,
      ref.assetId
    );
    const suffix = await assetResponse(
      assets,
      noAgentAttachment,
      new Request(url, { headers: { range: "bytes=-3" } }),
      url,
      ref.assetId
    );
    const head = await assetResponse(
      assets,
      noAgentAttachment,
      new Request(url, { method: "HEAD", headers: { range: "bytes=4-" } }),
      url,
      ref.assetId
    );

    expect(exact.status).toBe(206);
    expect(exact.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await exact.text()).toBe("2345");
    expect(await suffix.text()).toBe("789");
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("6");
    expect(await head.text()).toBe("");
  });

  test("rejects malformed and out-of-bounds ranges", async () => {
    const { assets, ref } = await fixture();
    const url = new URL(`http://openbot.test/api/v0/assets/${ref.assetId}?download=1`);
    for (const range of ["bytes=", "bytes=10-12", "bytes=7-2", "bytes=0-1,4-5"]) {
      const response = await assetResponse(
        assets,
        noAgentAttachment,
        new Request(url, { headers: { range } }),
        url,
        ref.assetId
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
  });

  test("serves the agent-local attachment after staging metadata is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-agent-attachment-http-"));
    roots.push(root);
    const bytes = Buffer.from("agent-local-authority");
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const path = join(root, `${assetId}.txt`);
    await writeFile(path, bytes);
    const assets = new AssetStore({ root: join(root, "empty-staging"), allowedFileRoots: [root] });
    const url = new URL(`http://openbot.test/api/v0/assets/${assetId}?name=local.txt`);
    const response = await assetResponse(
      assets,
      { agentAttachmentPath: async () => path },
      new Request(url),
      url,
      assetId
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("agent-local-authority");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });
});
