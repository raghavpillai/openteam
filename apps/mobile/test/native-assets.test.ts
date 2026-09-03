import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const bytesAt = async (relativePath: string) =>
  new Uint8Array(await Bun.file(new URL(relativePath, import.meta.url)).arrayBuffer());

const pngHeader = (bytes: Uint8Array) => {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    colorType: bytes[25],
  };
};

describe("checked-in iOS brand assets", () => {
  test("ships an opaque 1024px App Store icon", async () => {
    const catalogRoot = new URL(
      "../ios/OpenTeam/Images.xcassets/AppIcon.appiconset/",
      import.meta.url
    );
    const icon = pngHeader(
      await bytesAt("../ios/OpenTeam/Images.xcassets/AppIcon.appiconset/OpenTeam-App-Icon-v2.png")
    );
    expect(icon).toEqual({ width: 1024, height: 1024, colorType: 2 });

    const catalog = JSON.parse(
      await Bun.file(
        new URL("../ios/OpenTeam/Images.xcassets/AppIcon.appiconset/Contents.json", import.meta.url)
      ).text()
    ) as { images?: Array<{ filename?: string }> };
    expect(catalog.images?.[0]?.filename).toBe("OpenTeam-App-Icon-v2.png");
    expect((await readdir(catalogRoot)).filter((fileName) => fileName.endsWith(".png"))).toEqual([
      "OpenTeam-App-Icon-v2.png",
    ]);
  });

  test("provides every scale referenced by the launch storyboard", async () => {
    const root = "../ios/OpenTeam/Images.xcassets/SplashScreenLogo.imageset/";
    for (const [fileName, size] of [
      ["SplashScreenLogo.png", 120],
      ["SplashScreenLogo@2x.png", 240],
      ["SplashScreenLogo@3x.png", 360],
    ] as const) {
      const image = pngHeader(await bytesAt(`${root}${fileName}`));
      expect(image.width).toBe(size);
      expect(image.height).toBe(size);
      expect([4, 6]).toContain(image.colorType);
    }
    const storyboard = await Bun.file(
      new URL("../ios/OpenTeam/SplashScreen.storyboard", import.meta.url)
    ).text();
    expect(storyboard).toContain('image="SplashScreenLogo"');
    expect(storyboard).not.toContain('image="SplashScreen"');
  });
});
