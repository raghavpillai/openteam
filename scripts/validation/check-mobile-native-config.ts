import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const mobileRoot = resolve(repositoryRoot, "apps", "mobile");

interface ExpoConfig {
  expo: {
    version: string;
    ios?: {
      entitlements?: Record<string, unknown>;
      infoPlist?: Record<string, unknown>;
    };
    plugins?: Array<string | [string, Record<string, unknown>]>;
  };
}

interface IntrospectedConfig {
  _internal?: {
    modResults?: {
      ios?: {
        entitlements?: Record<string, unknown>;
        infoPlist?: Record<string, unknown>;
      };
    };
  };
}

interface AutolinkGraph {
  modules?: Array<{
    packageName?: string;
    packageVersion?: string;
    pods?: Array<{ podName?: string }>;
  }>;
}

const invariant = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(`iOS native config check failed: ${message}`);
};

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

const runJsonCommand = async <Result>(command: string[]): Promise<Result> => {
  const child = Bun.spawn([process.execPath, "x", ...command], {
    cwd: mobileRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr}\n${stdout}`);
  }
  return JSON.parse(stdout) as Result;
};

const [
  configText,
  infoPlist,
  entitlements,
  expoPlist,
  project,
  packageText,
  introspected,
  autolinkGraph,
] = await Promise.all([
  readFile(resolve(mobileRoot, "app.json"), "utf8"),
  readFile(resolve(mobileRoot, "ios", "OpenTeam", "Info.plist"), "utf8"),
  readFile(resolve(mobileRoot, "ios", "OpenTeam", "OpenTeam.entitlements"), "utf8"),
  readFile(resolve(mobileRoot, "ios", "OpenTeam", "Supporting", "Expo.plist"), "utf8"),
  readFile(resolve(mobileRoot, "ios", "OpenTeam.xcodeproj", "project.pbxproj"), "utf8"),
  readFile(resolve(mobileRoot, "package.json"), "utf8"),
  runJsonCommand<IntrospectedConfig>(["expo", "config", "--type", "introspect", "--json"]),
  runJsonCommand<AutolinkGraph>([
    "expo-modules-autolinking",
    "resolve",
    "--platform",
    "apple",
    "--json",
  ]),
]);

const config = JSON.parse(configText) as ExpoConfig;
const mobilePackage = JSON.parse(packageText) as {
  version?: string;
  dependencies?: Record<string, string>;
};
const generatedInfo = introspected._internal?.modResults?.ios?.infoPlist;
const generatedEntitlements = introspected._internal?.modResults?.ios?.entitlements;
const imagePicker = pluginOptions(config, "expo-image-picker");
const secureStore = pluginOptions(config, "expo-secure-store");

invariant(generatedInfo, "Expo introspection did not return an iOS Info.plist");
invariant(secureStore?.faceIDPermission === false, "unused Face ID permission must stay disabled");
invariant(
  generatedInfo.NSFaceIDUsageDescription === undefined &&
    plistString(infoPlist, "NSFaceIDUsageDescription") === null,
  "unused Face ID usage text was generated or checked in"
);

for (const [key, configured] of [
  ["NSCameraUsageDescription", imagePicker?.cameraPermission],
  ["NSPhotoLibraryUsageDescription", imagePicker?.photosPermission],
  ["NSLocalNetworkUsageDescription", config.expo.ios?.infoPlist?.NSLocalNetworkUsageDescription],
  ["NSMicrophoneUsageDescription", config.expo.ios?.infoPlist?.NSMicrophoneUsageDescription],
  [
    "NSSpeechRecognitionUsageDescription",
    config.expo.ios?.infoPlist?.NSSpeechRecognitionUsageDescription,
  ],
] as const) {
  invariant(typeof configured === "string" && configured.length > 0, `${key} is not configured`);
  invariant(
    (config.expo.ios?.infoPlist?.[key] ?? configured) === configured,
    `${key} conflicts inside app.json`
  );
  invariant(generatedInfo[key] === configured, `${key} differs from Expo introspection`);
  invariant(plistString(infoPlist, key) === configured, `${key} differs in checked-in Info.plist`);
}

invariant(
  imagePicker?.microphonePermission === config.expo.ios?.infoPlist?.NSMicrophoneUsageDescription,
  "microphone usage descriptions conflict"
);
invariant(mobilePackage.version === config.expo.version, "package and Expo versions differ");
invariant(
  plistString(infoPlist, "CFBundleShortVersionString") === config.expo.version,
  "Info.plist marketing version differs from app.json"
);
const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(
  (match) => match[1]
);
invariant(marketingVersions.length > 0, "Xcode project has no MARKETING_VERSION");
invariant(
  marketingVersions.every((version) => version === config.expo.version),
  "Xcode MARKETING_VERSION differs from app.json"
);

invariant(
  plistString(entitlements, "aps-environment") === "development",
  "source APNs entitlement must remain development for Expo/Xcode signing"
);
const keychainGroup = "$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)";
invariant(
  JSON.stringify(config.expo.ios?.entitlements?.["keychain-access-groups"]) ===
    JSON.stringify([keychainGroup]),
  "Expo config must preserve the default app-specific Keychain access group"
);
invariant(
  JSON.stringify(generatedEntitlements?.["keychain-access-groups"]) ===
    JSON.stringify([keychainGroup]),
  "Expo introspection did not generate the required Keychain access group"
);
invariant(
  /<key>keychain-access-groups<\/key>\s*<array>\s*<string>\$\(AppIdentifierPrefix\)\$\(PRODUCT_BUNDLE_IDENTIFIER\)<\/string>\s*<\/array>/.test(
    entitlements
  ),
  "checked-in native target is missing the required Keychain access group"
);
invariant(
  /<key>EXUpdatesEnabled<\/key>\s*<false\/>/.test(expoPlist),
  "store-only release policy requires Expo Updates to remain disabled"
);
invariant(
  mobilePackage.dependencies?.["expo-updates"] === undefined,
  "expo-updates was added without an explicit update policy"
);

const modules = autolinkGraph.modules ?? [];
const packageNames = modules.map((module) => module.packageName).filter(Boolean) as string[];
const podNames = modules.flatMap((module) =>
  (module.pods ?? []).map((pod) => pod.podName).filter(Boolean)
) as string[];
invariant(packageNames.length > 0, "Expo Apple autolinker resolved no modules");
invariant(
  new Set(packageNames).size === packageNames.length,
  "Expo Apple autolinker resolved a package more than once"
);
invariant(
  new Set(podNames).size === podNames.length,
  "Expo Apple autolinker resolved a pod more than once"
);
for (const requiredPackage of [
  "@openteam/mobile-native",
  "expo",
  "expo-notifications",
  "expo-router",
]) {
  invariant(
    packageNames.includes(requiredPackage),
    `${requiredPackage} is absent from autolinking`
  );
}

console.log(
  `iOS native config passes (${packageNames.length} unique Expo packages, ${podNames.length} unique pods, version ${config.expo.version}).`
);
