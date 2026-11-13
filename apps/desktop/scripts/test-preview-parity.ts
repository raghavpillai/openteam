import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const temporary = !process.env.OPENTEAM_PREVIEW_OUTPUT_DIR;
const directory =
  process.env.OPENTEAM_PREVIEW_OUTPUT_DIR ??
  (await mkdtemp(join(tmpdir(), "openteam-preview-parity-")));
await mkdir(directory, { recursive: true });
const root = resolve(import.meta.dir, "..");
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      rolldownOptions: { input: resolve(root, "test/browser/desktop-style-app.html") },
    },
  });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = reservation.port!;
  await reservation.stop(true);
  const url = pathToFileURL(join(directory, "dist/test/browser/desktop-style-app.html")).href;
  child = Bun.spawn(
    [
      createRequire(import.meta.url)("electron"),
      resolve(root, "test/browser/desktop-media-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        DESKTOP_MEDIA_PORT: String(port),
        DESKTOP_MEDIA_URL: url + "?theme=dark&preview-set",
        DESKTOP_MEDIA_PROFILE: join(directory, "profile"),
      },
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {}
    if (ready) break;
    await Bun.sleep(50);
  }
  if (!ready) throw Error("Native preview window did not start");
  const checks = Bun.spawn(
    ["node", resolve(root, "test/browser/preview-parity-checks.cjs"), String(port), url, directory],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (await checks.exited) throw Error("Preview parity checks failed");
} finally {
  child?.kill();
  if (child) await child.exited;
  if (temporary) await rm(directory, { recursive: true, force: true });
}
