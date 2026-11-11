import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

// Use the ordinary app config and a fresh dependency cache for each order. Test-only
// optimizeDeps overrides would hide a first-use parser reload in the real dev app.
for (const order of ["docx-first", "csv-first"]) {
  const directory = await mkdtemp(join(tmpdir(), "openteam-document-preview-cold-"));
  const server = await createServer({
    root: resolve(import.meta.dir, ".."),
    configFile: resolve(import.meta.dir, "../vite.config.ts"),
    cacheDir: join(directory, "vite"),
    server: { port: 0, strictPort: false },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await server.listen();
    child = Bun.spawn(
      [
        createRequire(import.meta.url)("electron"),
        resolve(import.meta.dir, "../test/browser/document-preview-cold-runner.cjs"),
      ],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          DOCUMENT_PREVIEW_COLD_DIR: directory,
          DOCUMENT_PREVIEW_COLD_ORDER: order,
          DOCUMENT_PREVIEW_COLD_URL: `${server.resolvedUrls!.local[0]}test/browser/desktop-style-app.html?files`,
        },
        stdout: "ignore",
        stderr: "pipe",
      }
    );
    timeout = setTimeout(() => child?.kill("SIGKILL"), 45_000);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code) throw Error(`Cold document preview process failed: ${stderr}`);
    const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
    console.log(JSON.stringify({ order, ...result }, null, 2));
    if (result.error) throw Error(result.error);
  } finally {
    if (timeout) clearTimeout(timeout);
    child?.kill();
    if (child) await child.exited;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
