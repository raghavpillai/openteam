import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export const MOBILE_EXPORT_BUDGETS = {
  // The iOS export includes the offline advanced-Markdown DOM runtime
  // (Mermaid/KaTeX) and the branded About artwork as native assets.
  assets: 30,
  assetBytes: 7_000_000,
  exactBundleBytes: 4_600_000,
  // Native settings, native table rendering, and conversation action parity
  // measure 3,707,924 B in the production source-mapped Hermes export.
  mappedBundleBytes: 3_708_000,
  metroModules: 2_250,
  sourceFiles: 1_850,
} as const;

export interface PackageRetention {
  modules: number;
  sourceCharacters: number;
}

export interface MobileExportMeasurement {
  exact: {
    assets: number;
    assetBytes: number;
    bundleBytes: number;
    bundleGzipBytes: number;
    bundleSha256: string;
    durationMs: number;
    hermesBytecodeVersion: number;
    metroModules: number;
    sourceMaps: number;
  };
  mapped: {
    bundleBytes: number;
    durationMs: number;
    metroModules: number;
    packages: Record<string, PackageRetention>;
    routes: string[];
    sourceFiles: number;
    sourceMapBytes: number;
  };
  expectedRoutes: string[];
}

export interface HermesSourceMap {
  sources: string[];
  sourcesContent?: Array<string | null>;
}

const bunPackagePattern = /\/node_modules\/\.bun\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/;
const regularPackagePattern = /\/node_modules\/((?:@[^/]+\/)?[^/]+)/;

export const packageForMobileSource = (source: string): string => {
  const normalized = source.replaceAll("\\", "/");
  const bunPackage = normalized.match(bunPackagePattern)?.[1];
  if (bunPackage) return bunPackage;
  const regularPackage = normalized.match(regularPackagePattern)?.[1];
  if (regularPackage) return regularPackage;
  if (normalized.includes("/apps/mobile/")) return "@openbot/mobile";
  const workspace = normalized.match(/\/packages\/([^/]+)\//)?.[1];
  return workspace ? `@openbot/${workspace}` : "(runtime/generated)";
};

export const routeForMobileSource = (source: string): string | null => {
  const normalized = source.replaceAll("\\", "/");
  const marker = "/apps/mobile/app/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const route = normalized.slice(index + marker.length);
  return /\.[cm]?[jt]sx?$/.test(route) ? route : null;
};

export const summarizeMobileSourceMap = (sourceMap: HermesSourceMap) => {
  const packages = new Map<string, PackageRetention>();
  const routes = new Set<string>();
  for (const [index, source] of sourceMap.sources.entries()) {
    const packageName = packageForMobileSource(source);
    const current = packages.get(packageName) ?? { modules: 0, sourceCharacters: 0 };
    current.modules += 1;
    current.sourceCharacters += sourceMap.sourcesContent?.[index]?.length ?? 0;
    packages.set(packageName, current);
    const route = routeForMobileSource(source);
    if (route) routes.add(route);
  }
  return {
    packages: Object.fromEntries(
      [...packages].sort(([left], [right]) => left.localeCompare(right))
    ),
    routes: [...routes].sort(),
    sourceFiles: sourceMap.sources.length,
  };
};

export const parseMetroModuleCount = (log: string): number => {
  const matches = [...log.matchAll(/\(([\d,]+) modules\)/g)];
  const raw = matches.at(-1)?.[1];
  if (!raw) throw new Error("Expo export did not report its Metro module count");
  return Number.parseInt(raw.replaceAll(",", ""), 10);
};

export const hermesBundleMetric = async (path: string) => {
  const bytes = await readFile(path);
  const magic = bytes.subarray(0, 8).toString("hex");
  if (magic !== "c61fbc03c103191f") {
    throw new Error(`${path} is not a Hermes bytecode bundle (magic ${magic || "missing"})`);
  }
  return {
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version: bytes.readUInt32LE(8),
  };
};

export const mobileBudgetFailures = (
  measurement: MobileExportMeasurement,
  budgets = MOBILE_EXPORT_BUDGETS
): string[] => {
  const failures: string[] = [];
  const atMost = (label: string, actual: number, maximum: number) => {
    if (actual > maximum) failures.push(`${label}: ${actual} > ${maximum}`);
  };
  atMost("exact Hermes bundle bytes", measurement.exact.bundleBytes, budgets.exactBundleBytes);
  atMost("mapped Hermes bundle bytes", measurement.mapped.bundleBytes, budgets.mappedBundleBytes);
  atMost("Metro modules", measurement.exact.metroModules, budgets.metroModules);
  atMost("mapped Metro modules", measurement.mapped.metroModules, budgets.metroModules);
  atMost("source-map sources", measurement.mapped.sourceFiles, budgets.sourceFiles);
  atMost("exported assets", measurement.exact.assets, budgets.assets);
  atMost("exported asset bytes", measurement.exact.assetBytes, budgets.assetBytes);
  if (measurement.exact.sourceMaps !== 0) {
    failures.push(`release export source maps: ${measurement.exact.sourceMaps} > 0`);
  }
  const expectedRoutes = [...measurement.expectedRoutes].sort();
  const mappedRoutes = [...measurement.mapped.routes].sort();
  if (JSON.stringify(expectedRoutes) !== JSON.stringify(mappedRoutes)) {
    failures.push(
      `route topology mismatch: expected ${expectedRoutes.join(", ")}; mapped ${mappedRoutes.join(", ")}`
    );
  }
  const forbiddenPackages = Object.keys(measurement.mapped.packages).filter(
    (name) => name === "effect" || name === "fast-check" || name.startsWith("@react-navigation/")
  );
  if (forbiddenPackages.length > 0) {
    failures.push(`forbidden mobile runtime packages: ${forbiddenPackages.join(", ")}`);
  }
  return failures;
};
