import { describe, expect, test } from "bun:test";

const source = (path: string) =>
  Bun.file(new URL(`../src/renderer/${path}`, import.meta.url)).text();

describe("desktop shared client controllers", () => {
  test("uses the shared screen session while retaining a desktop keepalive unload release", async () => {
    const screen = await source("components/openbot/bot-screen.tsx");

    expect(screen).toContain("createScreenSessionController");
    expect(screen).toContain("controller.stop()");
    expect(screen).toContain('window.addEventListener("pagehide", release)');
    expect(screen).toMatch(
      /const release = \(\) => \{\s*screenSession\.current\?\.deactivate\(\);\s*takeoverRef\.current = false;\s*api\.releaseScreenTakeover\(bot\.id\);/
    );
  });

  test("brokers remote desktop frames and input through the authenticated API", async () => {
    const screen = await source("components/openbot/bot-screen.tsx");

    expect(screen).toContain("api.screenFrameUrl");
    expect(screen).toContain("api.screenAction");
    expect(screen).not.toContain("<iframe");
    expect(screen).not.toContain("resolveViewerUrl");
  });
});
