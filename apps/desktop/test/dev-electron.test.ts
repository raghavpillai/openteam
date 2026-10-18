import { describe, expect, test } from "bun:test";
import {
  ELECTRON_BUNDLE_ARTIFACTS,
  isElectronBundleArtifact,
  resolveDevElectronEnvironment,
} from "../scripts/dev-electron-utils";

const desktopPackage = Bun.file(new URL("../package.json", import.meta.url)).json() as Promise<{
  scripts?: Record<string, string>;
}>;

describe("desktop development Electron supervisor", () => {
  test("derives the renderer URL and readiness target from the development host", () => {
    expect(resolveDevElectronEnvironment({})).toEqual({
      host: "127.0.0.1",
      rendererUrl: "http://127.0.0.1:5173",
      waitResource: "tcp:127.0.0.1:5173",
    });
    expect(resolveDevElectronEnvironment({ OPENTEAM_DEV_HOST: "100.94.42.50" })).toEqual({
      host: "100.94.42.50",
      rendererUrl: "http://100.94.42.50:5173",
      waitResource: "tcp:100.94.42.50:5173",
    });
  });

  test("preserves an explicit renderer URL without changing Vite readiness", () => {
    expect(
      resolveDevElectronEnvironment({
        OPENTEAM_DEV_HOST: "0.0.0.0",
        OPENTEAM_RENDERER_URL: "http://localhost:4173/preview",
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

  test("routes desktop development through the bundle supervisor", async () => {
    const packageJson = await desktopPackage;
    expect(packageJson.scripts?.dev).toContain("scripts/dev-electron.ts");
    expect(packageJson.scripts?.dev).toContain('"vite"');
    expect(packageJson.scripts?.dev).not.toContain(" electron .");
  });
});
