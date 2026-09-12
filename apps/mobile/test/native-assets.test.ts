import { describe, expect, test } from "bun:test";

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
  test("ships opaque 1024px light and dark fallback icons", async () => {
    for (const fileName of ["openteam-icon.png", "openteam-icon-dark.png"]) {
      const icon = pngHeader(await bytesAt(`../assets/${fileName}`));
      expect(icon).toEqual({ width: 1024, height: 1024, colorType: 2 });
    }
  });

  test("uses the shared layered icon for iOS with light and dark appearances", async () => {
    const mobileRoot = new URL("../", import.meta.url);
    const { expo } = await Bun.file(new URL("app.json", mobileRoot)).json();
    expect(expo.icon).toBe("./assets/openteam-icon.png");
    expect(expo.ios.icon).toBe("../../packages/design-tokens/assets/OpenTeam.icon");
    const iconRoot = new URL(`${expo.ios.icon}/`, mobileRoot);
    const icon = await Bun.file(new URL("icon.json", iconRoot)).json();
    expect(icon["supported-platforms"].squares).toBe("shared");
    expect(icon["fill-specializations"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.any(Object) }),
        expect.objectContaining({ appearance: "dark", value: expect.any(Object) }),
      ])
    );
    const layers = icon.groups.flatMap(
      (group: { layers: Array<{ "image-name": string }> }) => group.layers
    ) as Array<{ "image-name": string }>;
    expect(layers.map((layer) => layer["image-name"])).toEqual([
      "eyes.svg",
      "face.svg",
      "body.svg",
    ]);
    for (const layer of layers) {
      const svg = await Bun.file(new URL(`Assets/${layer["image-name"]}`, iconRoot)).text();
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 1024 1024"');
    }
    const project = await Bun.file(
      new URL("ios/OpenTeam.xcodeproj/project.pbxproj", mobileRoot)
    ).text();
    expect(project).toContain("OpenTeam.icon in Resources");
    expect(project).toContain("../../../packages/design-tokens/assets/OpenTeam.icon");
    expect(project.match(/ASSETCATALOG_COMPILER_APPICON_NAME = OpenTeam;/g)).toHaveLength(2);
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
