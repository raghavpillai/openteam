import { describe, expect, test } from "bun:test";

const mobileRoot = new URL("../", import.meta.url);
const readMobileFile = (relativePath: string) => Bun.file(new URL(relativePath, mobileRoot)).text();

interface ExpoConfig {
  expo: {
    version: string;
    android?: { package?: string };
    ios?: {
      entitlements?: Record<string, unknown>;
      infoPlist?: Record<string, unknown>;
    };
    plugins?: Array<string | [string, Record<string, unknown>]>;
  };
}

const plistString = (plist: string, key: string): string | null => {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match?.[1] ?? null;
};

const pluginOptions = (config: ExpoConfig, name: string): Record<string, unknown> | null => {
  const entry = config.expo.plugins?.find(
    (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name
  );
  return Array.isArray(entry) ? entry[1] : null;
};

describe("checked-in iOS native configuration", () => {
  test("matches configured usage descriptions and marketing version", async () => {
    const [configText, infoPlist, project, packageText] = await Promise.all([
      readMobileFile("app.json"),
      readMobileFile("ios/OpenBot/Info.plist"),
      readMobileFile("ios/OpenBot.xcodeproj/project.pbxproj"),
      readMobileFile("package.json"),
    ]);
    const config = JSON.parse(configText) as ExpoConfig;
    const mobilePackage = JSON.parse(packageText) as { version?: string };
    const imagePicker = pluginOptions(config, "expo-image-picker");
    const secureStore = pluginOptions(config, "expo-secure-store");

    expect(config.expo.android?.package).toBe("dev.openbot.mobile");
    expect(secureStore?.faceIDPermission).toBe(false);
    expect(plistString(infoPlist, "NSFaceIDUsageDescription")).toBeNull();

    for (const [key, configured] of [
      ["NSCameraUsageDescription", imagePicker?.cameraPermission],
      ["NSPhotoLibraryUsageDescription", imagePicker?.photosPermission],
      [
        "NSLocalNetworkUsageDescription",
        config.expo.ios?.infoPlist?.NSLocalNetworkUsageDescription,
      ],
      ["NSMicrophoneUsageDescription", config.expo.ios?.infoPlist?.NSMicrophoneUsageDescription],
      [
        "NSSpeechRecognitionUsageDescription",
        config.expo.ios?.infoPlist?.NSSpeechRecognitionUsageDescription,
      ],
    ] as const) {
      expect(typeof configured).toBe("string");
      expect(config.expo.ios?.infoPlist?.[key] ?? configured).toBe(configured);
      expect(plistString(infoPlist, key)).toBe(configured);
    }

    expect(imagePicker?.microphonePermission).toBe(
      config.expo.ios?.infoPlist?.NSMicrophoneUsageDescription
    );
    expect(mobilePackage.version).toBe(config.expo.version);
    expect(plistString(infoPlist, "CFBundleShortVersionString")).toBe(config.expo.version);
    const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(
      (match) => match[1]
    );
    expect(marketingVersions.length).toBeGreaterThan(0);
    expect(new Set(marketingVersions)).toEqual(new Set([config.expo.version]));
  });

  test("keeps required entitlements and the store-only update policy", async () => {
    const [configText, entitlements, expoPlist, packageText] = await Promise.all([
      readMobileFile("app.json"),
      readMobileFile("ios/OpenBot/OpenBot.entitlements"),
      readMobileFile("ios/OpenBot/Supporting/Expo.plist"),
      readMobileFile("package.json"),
    ]);
    const config = JSON.parse(configText) as ExpoConfig;
    const mobilePackage = JSON.parse(packageText) as {
      dependencies?: Record<string, string>;
    };
    const keychainGroup = "$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)";

    expect(plistString(entitlements, "aps-environment")).toBe("development");
    expect(config.expo.ios?.entitlements?.["keychain-access-groups"]).toEqual([keychainGroup]);
    expect(entitlements).toMatch(
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>\$\(AppIdentifierPrefix\)\$\(PRODUCT_BUNDLE_IDENTIFIER\)<\/string>\s*<\/array>/
    );
    expect(expoPlist).toMatch(/<key>EXUpdatesEnabled<\/key>\s*<false\/>/);
    expect(mobilePackage.dependencies?.["expo-updates"]).toBeUndefined();
  });

  test("guards unavailable audio input before installing the native recording tap", async () => {
    const module = await readMobileFile("modules/openbot-native/ios/OpenBotNativeModule.swift");

    expect(module).toContain("format.sampleRate.isFinite");
    expect(module).toContain("format.sampleRate > 0");
    expect(module).toContain("format.channelCount > 0");
    expect(module.indexOf("format.channelCount > 0")).toBeLessThan(
      module.indexOf("inputNode.installTap")
    );
  });

  test("reports native camera availability before image-picker presentation", async () => {
    const [module, bridge, composer] = await Promise.all([
      readMobileFile("modules/openbot-native/ios/OpenBotNativeModule.swift"),
      readMobileFile("modules/openbot-native/src/index.ts"),
      readMobileFile("src/components/composer.tsx"),
    ]);

    expect(module).toContain('Function("isCameraAvailable")');
    expect(module).toContain("UIImagePickerController.isSourceTypeAvailable(.camera)");
    expect(bridge).toContain("isCameraAvailable(): boolean");
    expect(composer).toContain("if (isCameraAvailable() === false)");
    expect(composer).toContain("disabled={isCameraAvailable() === false}");
    expect(composer.indexOf("if (isCameraAvailable() === false)")).toBeLessThan(
      composer.indexOf("ImagePicker.requestCameraPermissionsAsync()")
    );
  });
});
