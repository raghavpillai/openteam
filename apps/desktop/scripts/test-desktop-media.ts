import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const directory = await mkdtemp(join(tmpdir(), "openteam-desktop-media-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  cacheDir: join(directory, "vite"),
  optimizeDeps: { include: ["xlsx", "mammoth"] },
  server: { port: 0, strictPort: false },
});
let child: ReturnType<typeof Bun.spawn> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  await server.listen();
  const url = `${server.resolvedUrls!.local[0]}test/browser/desktop-style-app.html`;
  // Reserve an ephemeral port before handing it to Electron's local CDP listener.
  const reservation = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = reservation.port!;
  await reservation.stop(true);
  child = Bun.spawn(
    [
      createRequire(import.meta.url)("electron"),
      resolve(import.meta.dir, "../test/browser/desktop-media-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        DESKTOP_MEDIA_PORT: String(port),
        DESKTOP_MEDIA_URL: url,
        DESKTOP_MEDIA_PROFILE: join(directory, "profile"),
      },
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  timeout = setTimeout(() => child?.kill("SIGKILL"), 90_000);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      /* Electron is starting. */
    }
    if (ready) break;
    await Bun.sleep(50);
  }
  if (!ready) throw Error("Native media test window did not start");
  const checks = Bun.spawn(
    [
      "node",
      resolve(import.meta.dir, "../test/browser/desktop-media-checks.cjs"),
      String(port),
      url,
      directory,
    ],
    { stdout: "inherit", stderr: "pipe" }
  );
  const [code, stderr] = await Promise.all([checks.exited, new Response(checks.stderr).text()]);
  if (code) throw Error(`Native attachment checks failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "native-interactions.json"), "utf8"));
  console.log(
    JSON.stringify(
      {
        checks: result.checks.length,
        scenarios: [...new Set(result.checks.map((check: { phase: string }) => check.phase))],
        errors: result.errors,
      },
      null,
      2
    )
  );
} finally {
  if (timeout) clearTimeout(timeout);
  child?.kill();
  if (child) await child.exited;
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
