// Shared driver for the Electron fixture checks in scripts/test-fixtures.ts: serve the
// desktop renderer through Vite, launch electron-runner.cjs against one fixture page
// (fixture.html?page=<name>), and return the results.json it writes.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type InlineConfig } from "vite";

const desktopRoot = resolve(import.meta.dir, "../..");
export const electron = createRequire(import.meta.url)("electron") as string;

export type FixtureRun = {
  /** Temp directory prefix and error label. */
  name: string;
  /** Page module in test/browser, optionally followed by &query parameters. */
  page: string;
  /** Driver module in test/browser; without one the page reports its own result. */
  driver?: string;
  timeoutMs: number;
  /** Build anything the driver loads from the working directory before Electron starts. */
  prepare?: (directory: string) => Promise<void>;
  vite?: InlineConfig;
};

export async function runElectronFixture({ name, page, driver, timeoutMs, prepare, vite }: FixtureRun) {
  const directory = await mkdtemp(join(tmpdir(), `openteam-${name}-`));
  const server = await createServer({
    root: desktopRoot,
    configFile: join(desktopRoot, "vite.config.ts"),
    cacheDir: join(directory, "vite-cache"),
    logLevel: "warn",
    ...vite,
    server: { port: 0, strictPort: false, hmr: false, ...vite?.server },
  });
  try {
    await prepare?.(directory);
    await server.listen();
    const url = `${server.resolvedUrls!.local[0]}test/browser/fixture.html?page=${page}`;
    const child = Bun.spawn([electron, join(desktopRoot, "test/browser/electron-runner.cjs")], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        FIXTURE_DIR: directory,
        FIXTURE_URL: url,
        FIXTURE_DRIVER: driver,
      },
      stdout: "inherit",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timeout);
    const output = await readFile(join(directory, "results.json"), "utf8").catch(() => "");
    if (code) throw new Error(`${name} failed (exit ${code}): ${output}\n${stderr}`);
    const result = JSON.parse(output);
    if (result.error) throw new Error(`${name}: ${result.error}\n${result.stack ?? ""}`);
    return result;
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Run one fixture and print its results. */
export async function runAndPrint(run: FixtureRun) {
  const result = await runElectronFixture(run);
  if (Array.isArray(result.reports) && result.reports.every((r: unknown) => typeof r === "string"))
    for (const report of result.reports) console.log(`PASS ${run.name}: ${report}`);
  else console.log(JSON.stringify(result, null, 2));
  return result;
}
