import { describe, expect, test } from "bun:test";
import {
  MOBILE_EXPORT_BUDGETS,
  type MobileExportMeasurement,
  mobileBudgetFailures,
  packageForMobileSource,
  parseMetroModuleCount,
  routeForMobileSource,
  summarizeMobileSourceMap,
} from "./mobile-export-measurement-utils";

const passingMeasurement = (): MobileExportMeasurement => ({
  exact: {
    assets: 23,
    assetBytes: 25_000,
    bundleBytes: 4_100_000,
    bundleGzipBytes: 1_500_000,
    bundleSha256: "a".repeat(64),
    durationMs: 1,
    hermesBytecodeVersion: 98,
    metroModules: 1_776,
    sourceMaps: 0,
  },
  mapped: {
    bundleBytes: 3_330_000,
    durationMs: 1,
    metroModules: 1_776,
    packages: {
      "@openbot/mobile": { modules: 29, sourceCharacters: 250_000 },
      "expo-router": { modules: 377, sourceCharacters: 1_220_000 },
    },
    routes: ["_layout.tsx", "index.tsx"],
    sourceFiles: 1_759,
    sourceMapBytes: 8_600_000,
  },
  expectedRoutes: ["_layout.tsx", "index.tsx"],
});

describe("mobile export measurement", () => {
  test("attributes Bun-isolated, regular, workspace, and application sources", () => {
    expect(
      packageForMobileSource(
        "/node_modules/.bun/@react-navigation+native@7.3.18/node_modules/@react-navigation/native/lib/index.js"
      )
    ).toBe("@react-navigation/native");
    expect(packageForMobileSource("/node_modules/effect/dist/esm/Effect.js")).toBe("effect");
    expect(packageForMobileSource("/packages/client-core/src/client.ts")).toBe(
      "@openbot/client-core"
    );
    expect(packageForMobileSource("/apps/mobile/src/auth.ts")).toBe("@openbot/mobile");
  });

  test("extracts only application route modules", () => {
    expect(routeForMobileSource("/apps/mobile/app/chat/[channelId].tsx")).toBe(
      "chat/[channelId].tsx"
    );
    expect(routeForMobileSource("/apps/mobile/src/search.ts")).toBeNull();
    expect(routeForMobileSource("/apps/mobile/app?ctx=abc")).toBeNull();
  });

  test("summarizes retained sources and routes", () => {
    const summary = summarizeMobileSourceMap({
      sources: [
        "/apps/mobile/app/index.tsx",
        "/node_modules/.bun/effect@3.22.1/node_modules/effect/dist/esm/Effect.js",
      ],
      sourcesContent: ["home", "effect-source"],
    });
    expect(summary.routes).toEqual(["index.tsx"]);
    expect(summary.packages.effect).toEqual({ modules: 1, sourceCharacters: 13 });
    expect(summary.sourceFiles).toBe(2);
  });

  test("parses the final Metro module count", () => {
    expect(parseMetroModuleCount("iOS Bundled entry.js (1,776 modules)\n")).toBe(1_776);
  });

  test("passes a bounded export and rejects bloat, forbidden packages, and route drift", () => {
    expect(mobileBudgetFailures(passingMeasurement())).toEqual([]);
    const failing = passingMeasurement();
    failing.exact.bundleBytes = MOBILE_EXPORT_BUDGETS.exactBundleBytes + 1;
    failing.exact.sourceMaps = 1;
    failing.mapped.packages.effect = { modules: 1, sourceCharacters: 1 };
    failing.mapped.routes = ["index.tsx"];
    const failures = mobileBudgetFailures(failing);
    expect(failures.some((failure) => failure.startsWith("exact Hermes bundle bytes"))).toBe(true);
    expect(failures.some((failure) => failure.startsWith("release export source maps"))).toBe(true);
    expect(
      failures.some((failure) => failure.startsWith("forbidden mobile runtime packages"))
    ).toBe(true);
    expect(failures.some((failure) => failure.startsWith("route topology mismatch"))).toBe(true);
  });
});
