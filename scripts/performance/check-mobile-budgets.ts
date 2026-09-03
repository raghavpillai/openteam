import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  type HermesSourceMap,
  hermesBundleMetric,
  type MobileExportMeasurement,
  mobileBudgetFailures,
  parseMetroModuleCount,
  summarizeMobileSourceMap,
} from "./mobile-export-measurement-utils";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const mobileRoot = resolve(repositoryRoot, "apps", "mobile");
const temporaryRoot = await mkdtemp(join(tmpdir(), "openteam-ios-performance-"));

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
  );
  return children.flat().sort();
};

const runExport = async (output: string, sourceMaps: boolean) => {
  const command = [
    process.execPath,
    "x",
    "expo",
    "export",
    "--platform",
    "ios",
    "--output-dir",
    output,
    ...(!sourceMaps ? ["--clear"] : []),
    ...(sourceMaps ? ["--source-maps", "external"] : []),
  ];
  const startedAt = performance.now();
  const child = Bun.spawn(command, {
    cwd: mobileRoot,
    env: {
      ...process.env,
      // Match the mobile package's production export. Expo 57 DOM components
      // otherwise reference a shared web chunk that its iOS export omits.
      EXPO_NO_BUNDLE_SPLITTING: "1",
      EXPO_PUBLIC_EXPO_PROJECT_ID: "",
      EXPO_PUBLIC_OPENTEAM_API_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const log = `${stdout}\n${stderr}`;
  if (exitCode !== 0) {
    throw new Error(`iOS Expo export failed (${exitCode})\n${log}`);
  }
  return {
    durationMs: Math.round(performance.now() - startedAt),
    log,
    metroModules: parseMetroModuleCount(log),
  };
};

const expectedRoutes = (await walk(resolve(mobileRoot, "app")))
  .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
  .map((path) => relative(resolve(mobileRoot, "app"), path).replaceAll("\\", "/"))
  .sort();

try {
  const exactRoot = resolve(temporaryRoot, "exact");
  const mappedRoot = resolve(temporaryRoot, "mapped");
  const exactExport = await runExport(exactRoot, false);
  const mappedExport = await runExport(mappedRoot, true);
  const exactFiles = await walk(exactRoot);
  const mappedFiles = await walk(mappedRoot);
  const exactBundles = exactFiles.filter((path) => path.endsWith(".hbc"));
  const mappedBundles = mappedFiles.filter((path) => path.endsWith(".hbc"));
  const sourceMaps = mappedFiles.filter((path) => path.endsWith(".hbc.map"));
  if (exactBundles.length !== 1 || mappedBundles.length !== 1 || sourceMaps.length !== 1) {
    throw new Error(
      `Expected one exact HBC, one mapped HBC, and one source map; found ${exactBundles.length}, ${mappedBundles.length}, and ${sourceMaps.length}`
    );
  }
  const metadata = JSON.parse(await readFile(resolve(exactRoot, "metadata.json"), "utf8")) as {
    bundler?: unknown;
    fileMetadata?: { ios?: { assets?: Array<{ path?: unknown }>; bundle?: unknown } };
  };
  if (metadata.bundler !== "metro") throw new Error("iOS export metadata is not from Metro");
  const assetPaths = (metadata.fileMetadata?.ios?.assets ?? [])
    .map((asset) => asset.path)
    .filter((path): path is string => typeof path === "string");
  const uniqueAssetPaths = [...new Set(assetPaths)].sort();
  const assetBytes = (
    await Promise.all(
      uniqueAssetPaths.map(async (path) => (await stat(resolve(exactRoot, path))).size)
    )
  ).reduce((total, bytes) => total + bytes, 0);
  const exactMetric = await hermesBundleMetric(exactBundles[0] as string);
  const mappedMetric = await hermesBundleMetric(mappedBundles[0] as string);
  const sourceMap = JSON.parse(await readFile(sourceMaps[0] as string, "utf8")) as HermesSourceMap;
  const mappedSummary = summarizeMobileSourceMap(sourceMap);
  const measurement: MobileExportMeasurement = {
    exact: {
      assets: uniqueAssetPaths.length,
      assetBytes,
      bundleBytes: exactMetric.bytes,
      bundleGzipBytes: exactMetric.gzipBytes,
      bundleSha256: exactMetric.sha256,
      durationMs: exactExport.durationMs,
      hermesBytecodeVersion: exactMetric.version,
      metroModules: exactExport.metroModules,
      sourceMaps: exactFiles.filter((path) => path.endsWith(".map")).length,
    },
    mapped: {
      bundleBytes: mappedMetric.bytes,
      durationMs: mappedExport.durationMs,
      metroModules: mappedExport.metroModules,
      packages: mappedSummary.packages,
      routes: mappedSummary.routes,
      sourceFiles: mappedSummary.sourceFiles,
      sourceMapBytes: (await stat(sourceMaps[0] as string)).size,
    },
    expectedRoutes,
  };
  const failures = mobileBudgetFailures(measurement);
  if (process.argv.includes("--json")) console.log(JSON.stringify(measurement, null, 2));
  if (failures.length > 0) {
    console.error(
      `iOS performance budgets failed:\n${failures.map((item) => `- ${item}`).join("\n")}`
    );
    process.exitCode = 1;
  } else if (!process.argv.includes("--json")) {
    console.log(
      `iOS performance budgets pass (${measurement.exact.bundleBytes} B HBC, ${measurement.exact.metroModules} modules, ${measurement.exact.assets} assets, ${measurement.mapped.sourceFiles} mapped sources).`
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
