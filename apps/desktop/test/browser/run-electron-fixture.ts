// Shared driver for the Electron fixture checks in scripts/test-*.ts: serve the
// desktop renderer through Vite, launch an Electron runner from this directory
// against one fixture page, and return the results.json the runner writes.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type InlineConfig } from "vite";

const desktopRoot = resolve(import.meta.dir, "../..");
const electron = createRequire(import.meta.url)("electron") as string;

export type FixtureRun = {
  /** Temp directory prefix and error label. */
  name: string;
  /** Runner file in test/browser. */
  runner: string;
  /** Fixture page in test/browser, optionally with a query string. */
  page: string;
  /** Environment for the runner, given the working directory and fixture URL. */
  env: (directory: string, url: string) => Record<string, string>;
  timeoutMs: number;
  /** Keep the runner's output (screenshots, results) here instead of a temp directory. */
  directory?: string;
  vite?: InlineConfig;
};

export async function runElectronFixture({
  name,
  runner,
  page,
  env,
  timeoutMs,
  directory: keep,
  vite,
}: FixtureRun) {
  const scratch = await mkdtemp(join(tmpdir(), `openteam-${name}-`));
  const directory = keep ? resolve(keep) : scratch;
  await mkdir(directory, { recursive: true });
  await rm(join(directory, "results.json"), { force: true });
  const server = await createServer({
    root: desktopRoot,
    configFile: join(desktopRoot, "vite.config.ts"),
    cacheDir: join(scratch, "vite-cache"),
    ...vite,
    server: { port: 0, strictPort: false, hmr: false, ...vite?.server },
  });
  try {
    await server.listen();
    const url = `${server.resolvedUrls!.local[0]}test/browser/${page}`;
    const child = Bun.spawn([electron, join(desktopRoot, "test/browser", runner)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...env(directory, url) },
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
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Run one fixture and print its results; for scripts that need nothing else. */
export async function runAndPrint(run: FixtureRun) {
  const result = await runElectronFixture(run);
  if (Array.isArray(result.reports) && result.reports.every((r: unknown) => typeof r === "string"))
    for (const report of result.reports) console.log(`PASS ${report}`);
  else console.log(JSON.stringify(result, null, 2));
  return result;
}
