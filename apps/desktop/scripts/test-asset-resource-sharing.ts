// Shared authenticated image resources: aliases, Markdown images, revisions, credential
// changes and aborted loads against the shipping server asset handler.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "vite";
import { assetResponse } from "../../server/src/asset-http";

const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "openteam-asset-sharing-"));
const bytes = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="teal"/><!--${"a".repeat(1024 * 1024)}--></svg>`
);
const digest = createHash("sha256").update(bytes).digest("hex");
const content = join(temporary, "original.svg");
await Bun.write(content, bytes);
const assets = {
  metadata: async () => ({
    assetId: "a".repeat(64),
    byteSize: bytes.length,
    mimeType: "image/svg+xml",
    kind: "image",
  }),
  contentPath: () => content,
};
const agentData = { agentAttachmentPath: async () => null };
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const renderer = join(temporary, "renderer");
  await build({
    root: resolve(import.meta.dir, ".."),
    configFile: resolve(import.meta.dir, "../vite.config.ts"),
    logLevel: "warn",
    build: {
      outDir: renderer,
      emptyOutDir: true,
      rolldownOptions: {
        input: resolve(import.meta.dir, "../test/browser/asset-resource-sharing.html"),
      },
    },
  });
  {
    let serverAssetRequests = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v0/bots/fixture/avatar") {
          const color = url.searchParams.get("revision") === "2" ? "orange" : "teal";
          return new Response(
            `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="${color}"/></svg>`,
            {
              headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
            }
          );
        }
        const match = /^\/api\/(?:v0\/)?assets\/([a-f0-9]{64})$/.exec(url.pathname);
        if (match) {
          serverAssetRequests++;
          // The shipping handler supplies its actual immutable/private cache policy.
          return assetResponse(assets as never, agentData, request, url, match[1]!);
        }
        const filePath = resolve(renderer, "." + decodeURIComponent(url.pathname));
        if (!filePath.startsWith(renderer + "/")) return new Response(null, { status: 404 });
        const file = Bun.file(filePath);
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      },
    });
    const resultPath = join(temporary, "results.json");
    const child = Bun.spawn(
      [
        require("electron") as string,
        resolve(import.meta.dir, "../test/browser/asset-resource-sharing-runner.cjs"),
      ],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          ASSET_SHARING_PROFILE: join(temporary, "profile"),
          ASSET_SHARING_URL: `${server.url}test/browser/asset-resource-sharing.html`,
          ASSET_SHARING_RESULT: resultPath,
          ASSET_SHARING_HASH: digest,
        },
        stdout: "inherit",
        stderr: "pipe",
      }
    );
    const timeout = setTimeout(() => child.kill(), 60_000);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timeout);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.serverAssetRequests = serverAssetRequests;
    await Bun.write(resultPath, JSON.stringify(result, null, 2));
    if (code || result.error) throw Error(result.error ?? stderr);
    console.log(
      JSON.stringify(
        {
          blobCount: result.initial.blobCount,
          retainedBlobBytes: result.initial.blobBytes,
          applicationFetches: result.initial.requests,
          serverAssetRequests,
          assertions: result.reports.length,
        },
        null,
        2
      )
    );
  }
} finally {
  server?.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
