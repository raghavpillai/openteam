import { describe, expect, test } from "bun:test";

const readDesktopFile = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("desktop packaging and content security policy", () => {
  test("allows user-selected HTTP servers without allowing remote scripts", async () => {
    const html = await readDesktopFile("index.html");

    expect(html).toContain("connect-src 'self' http: https:");
    expect(html).toContain("img-src 'self' data: blob: openteam-staged: http: https:");
    expect(html).toContain("frame-src http: https:");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toContain("script-src 'self' http:");
  });

  test("keeps bundled libraries out of packaged runtime dependencies", async () => {
    const packageJson = JSON.parse(await readDesktopFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([]);
    for (const dependency of ["electron-updater", "react", "mammoth", "pdfjs-dist", "xlsx"]) {
      expect(packageJson.devDependencies?.[dependency]).toBeDefined();
    }
    expect(packageJson.devDependencies?.["tw-animate-css"]).toBeUndefined();
  });
});
