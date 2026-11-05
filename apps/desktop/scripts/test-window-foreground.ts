import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const baseline = process.argv[2];
if (!baseline) throw Error("Usage: bun scripts/test-window-foreground.ts /absolute/path/to/baseline-checkout");
const candidate = resolve(import.meta.dir, "../../..");
const directory = await mkdtemp(join(tmpdir(), "openteam-foreground-parity-"));
const output = join(candidate, "output/window-foreground");
await mkdir(output, { recursive: true });
const fixtureHtml = (await readFile(resolve(import.meta.dir, "../test/browser/window-foreground.html"), "utf8")).replace("./window-foreground.tsx", "/test/browser/__foreground-parity.tsx");
const fixtureSource = await readFile(resolve(import.meta.dir, "../test/browser/window-foreground.tsx"), "utf8");
try {
  for (const [arm, checkout] of [["baseline", baseline], ["candidate", candidate]]) {
    const root = join(checkout!, "apps/desktop");
    const preload = await Bun.build({ entrypoints: [join(root, "src/preload/index.ts")],
      outdir: directory, naming: `${arm}-preload.cjs`, target: "node", format: "cjs", external: ["electron"] });
    if (!preload.success) throw Error(`Preload failed: ${preload.logs.join("\n")}`);
    const virtualFixture = join(root, "test/browser/__foreground-parity.tsx");
    const server = await createServer({ root, configFile: join(root, "vite.config.ts"), cacheDir: join(directory, `${arm}-cache`), server: { port: 0, strictPort: false, hmr: false }, plugins: [{
      name: "foreground-parity-fixture", enforce: "pre",
      resolveId(id) { if (id === "/test/browser/__foreground-parity.tsx" || id === virtualFixture || id === `/@fs${virtualFixture}`) return virtualFixture; },
      load(id) { if (id === virtualFixture) return fixtureSource; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/test/browser/window-foreground.html")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(await server.transformIndexHtml(request.url, fixtureHtml));
        });
      },
    }] });
    try {
      await server.listen();
      const child = Bun.spawn([createRequire(import.meta.url)("electron") as string, resolve(import.meta.dir, "../test/browser/window-foreground-runner.cjs")], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, FOREGROUND_PARITY_ARM: arm, FOREGROUND_PARITY_DIR: directory,
          FOREGROUND_PARITY_OUTPUT: output, FOREGROUND_PARITY_URL: `${server.resolvedUrls!.local[0]}test/browser/window-foreground.html` }, stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      clearTimeout(timer);
      if (code) throw Error(`${arm} Electron failed: ${errors}`);
    } finally { await server.close(); }
  }
  const results = JSON.parse(await readFile(join(output, "candidate-results.json"), "utf8")) as Array<{name: string; differentPixels?: number; geometryEqual?: boolean; canvasesEqual?: boolean}>;
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.differentPixels !== undefined && (result.differentPixels > 0 || !result.geometryEqual || !result.canvasesEqual))) throw Error(`Foreground visual difference; inspect ${output}`);
} finally { await rm(directory, { recursive: true, force: true }); }
