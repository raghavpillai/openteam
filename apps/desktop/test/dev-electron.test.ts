import { describe, expect, test } from "bun:test";
import {
  ELECTRON_BUNDLE_ARTIFACTS,
  isElectronBundleArtifact,
  resolveDevElectronEnvironment,
} from "../scripts/dev-electron-utils";

const desktopPackage = Bun.file(new URL("../package.json", import.meta.url)).json() as Promise<{
  scripts?: Record<string, string>;
}>;
const mainSource = Bun.file(new URL("../src/main/index.ts", import.meta.url)).text();
const supervisorSource = Bun.file(new URL("../scripts/dev-electron.ts", import.meta.url)).text();

describe("desktop development Electron supervisor", () => {
  test("derives the renderer URL and readiness target from the development host", () => {
    expect(resolveDevElectronEnvironment({})).toEqual({
      host: "127.0.0.1",
      rendererUrl: "http://127.0.0.1:5173",
      waitResource: "tcp:127.0.0.1:5173",
    });
    expect(resolveDevElectronEnvironment({ OPENBOT_DEV_HOST: "100.94.42.50" })).toEqual({
      host: "100.94.42.50",
      rendererUrl: "http://100.94.42.50:5173",
      waitResource: "tcp:100.94.42.50:5173",
    });
  });

  test("preserves an explicit renderer URL without changing Vite readiness", () => {
    expect(
      resolveDevElectronEnvironment({
        OPENBOT_DEV_HOST: "0.0.0.0",
        OPENBOT_RENDERER_URL: "http://localhost:4173/preview",
      })
    ).toEqual({
      host: "0.0.0.0",
      rendererUrl: "http://localhost:4173/preview",
      waitResource: "tcp:0.0.0.0:5173",
    });
  });

  test("restarts only for complete Electron bundle artifacts", () => {
    for (const artifact of ELECTRON_BUNDLE_ARTIFACTS) {
      expect(isElectronBundleArtifact(artifact)).toBe(true);
    }
    expect(isElectronBundleArtifact("main.js.tmp")).toBe(false);
    expect(isElectronBundleArtifact("renderer.js")).toBe(false);
    expect(isElectronBundleArtifact("chunks/main.js")).toBe(true);
    expect(isElectronBundleArtifact("chunks\\index.js")).toBe(true);
    expect(isElectronBundleArtifact(null)).toBe(true);
  });

  test("uses the production main-process split and watches lazy chunks", async () => {
    const source = await supervisorSource;
    expect(source).toContain('"--outdir",\n    "dist-electron"');
    expect(source).toContain('"--entry-naming",\n    "main.js"');
    expect(source).toContain('"--chunk-naming",\n    "chunks/[name].[ext]"');
    expect(source).toContain('"--splitting"');
    expect(source).toContain("watch(bundleRoot, { recursive: true }");
  });

  test("routes desktop development through the bundle supervisor", async () => {
    const packageJson = await desktopPackage;
    expect(packageJson.scripts?.dev).toContain("scripts/dev-electron.ts");
    expect(packageJson.scripts?.dev).toContain('"vite"');
    expect(packageJson.scripts?.dev).not.toContain(" electron .");
  });

  test("ignores environment-selected renderer pages in packaged builds", async () => {
    expect(await mainSource).toContain(
      "app.isPackaged ? undefined : process.env.OPENBOT_RENDERER_URL"
    );
  });
});
