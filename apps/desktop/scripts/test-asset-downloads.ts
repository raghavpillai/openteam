import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

// Exercises the real main process, sandboxed preload, file:// preview UI, net.fetch,
// and filesystem. Only the native picker/warning dialogs have scripted responses.
const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "openteam-asset-downloads-"));
const baseline = process.argv[2] === "--baseline" ? process.argv[3] : undefined;
const pdfPath = process.env.ASSET_DOWNLOAD_PDF ?? resolve(root, "../computer/test/fixtures/input-parity/three-pages.pdf");
const pdf = await readFile(pdfPath);
const asset = createHash("sha256").update(pdf).digest("hex");
const token = "native-download-fixture-token";
const requests: Array<{ download: boolean; authorized: boolean }> = [];
let redirected = false;
let mode = "success";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (url.pathname === "/api/auth/config") return Response.json({ mode: "required" }, { headers });
    if (url.pathname === "/api/auth/get-session") return Response.json({
      session: { id: "fixture-session" },
      user: { id: "fixture-owner", name: "Fixture", email: "fixture@example.test" },
    }, { headers });
    if (url.pathname.startsWith("/fixture-mode/")) {
      mode = url.pathname.split("/").at(-1)!;
      return new Response(null);
    }
    if (url.pathname === "/redirect-target") {
      redirected = true;
      return new Response("Redirect must never be followed", { headers });
    }
    if (url.pathname !== `/api/v0/assets/${asset}`) return new Response(null, { status: 404, headers });
    const authorized = request.headers.get("authorization") === `Bearer ${token}`;
    requests.push({ download: url.searchParams.get("download") === "1", authorized });
    if (!authorized || mode === "unauthorized") return new Response(null, { status: 401, headers });
    if (mode === "redirect") return new Response(null, { status: 302, headers: { ...headers, location: "/redirect-target" } });
    return new Response(pdf, { headers: { ...headers, "content-type": "application/pdf", "content-length": String(pdf.length) } });
  },
});
let child: ReturnType<typeof Bun.spawn> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  const nativeDirectory = join(directory, "dist-electron");
  await mkdir(nativeDirectory);
  let baselineSource: string | undefined;
  if (baseline) {
    const result = Bun.spawnSync(["git", "show", `${baseline}:apps/desktop/src/main/index.ts`], { cwd: root });
    if (result.exitCode) throw new Error(result.stderr.toString());
    baselineSource = result.stdout.toString();
  }
  const main = await Bun.build({
    entrypoints: [join(root, "src/main/index.ts")],
    outdir: nativeDirectory,
    naming: "main.js",
    target: "node",
    format: "esm",
    external: ["electron"],
    plugins: baselineSource ? [{
      name: "baseline-main",
      setup(builder) {
        builder.onLoad({ filter: /src\/main\/index\.ts$/ }, () => ({
          contents: baselineSource!, loader: "ts", resolveDir: join(root, "src/main"),
        }));
      },
    }] : [],
  });
  const preload = await Bun.build({
    entrypoints: [join(root, "src/preload/index.ts")],
    outdir: nativeDirectory,
    naming: "preload.cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!main.success || !preload.success) throw new Error([...main.logs, ...preload.logs].join("\n"));
  await build({
    root,
    configFile: join(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      rolldownOptions: { input: join(root, "test/browser/asset-download.html") },
    },
  });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    server: `http://127.0.0.1:${server.port}`,
    otherServer: `http://localhost:${server.port}`,
    renderer: join(directory, "dist/test/browser/asset-download.html"),
    asset, bytes: pdf.length, token, baseline: Boolean(baseline),
  }));
  await copyFile(join(root, "test/browser/asset-download-driver.cjs"), join(directory, "driver.cjs"));
  child = Bun.spawn([createRequire(import.meta.url)("electron"), join(directory, "driver.cjs")], {
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      OPENTEAM_SERVER_URL: undefined,
      OPENTEAM_RENDERER_URL: undefined,
      OPENTEAM_HOST_BRIDGE_PORT: "0",
      OPENTEAM_CONTROL_TOKEN: "local-compose-only-change-me",
      ASSET_DOWNLOAD_DIR: directory,
    },
    stdout: "pipe", stderr: "pipe",
  });
  timeout = setTimeout(() => child?.kill("SIGKILL"), 30_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8").catch(() => "{}"));
  if (code || result.error || !result.checks?.length) throw new Error(JSON.stringify({ code, result, stdout, stderr }));
  if (!requests.some(request => !request.download && request.authorized)) throw new Error("PDF preview never fetched authenticated bytes");
  if (requests.some(request => !request.authorized) || redirected) throw new Error("Authentication or redirect guard failed");
  const downloads = requests.filter(request => request.download).length;
  if (downloads !== (baseline ? 0 : 4)) throw new Error(`Unexpected native asset fetch count: ${downloads}`);
  console.log(JSON.stringify({ ...result, baseline: baseline ?? null, bytes: pdf.length, authenticatedNativeRequests: downloads }, null, 2));
} finally {
  if (timeout) clearTimeout(timeout);
  child?.kill();
  if (child) await child.exited;
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
