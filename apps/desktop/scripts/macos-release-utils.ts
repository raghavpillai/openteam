export const MACOS_RELEASE_ENTITLEMENTS = "build/entitlements.mac.plist";

export type MacosNotarizationMode = "api-key" | "apple-id" | "keychain-profile";

export interface MacosReleaseEnvironment {
  identity: string;
  notarizationMode: MacosNotarizationMode;
}

const complete = (env: NodeJS.ProcessEnv, names: readonly string[]) =>
  names.every((name) => Boolean(env[name]?.trim()));
const started = (env: NodeJS.ProcessEnv, names: readonly string[]) =>
  names.some((name) => Boolean(env[name]?.trim()));

export const resolveMacosReleaseEnvironment = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): MacosReleaseEnvironment => {
  if (platform !== "darwin") {
    throw new Error("Signed macOS releases can only be built on macOS.");
  }

  const identity = env.CSC_NAME?.trim();
  if (!identity || identity === "-") {
    throw new Error(
      "CSC_NAME must name the Developer ID Application identity for a signed macOS release."
    );
  }

  const notarizationOptions = [
    {
      mode: "apple-id" as const,
      names: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
      triggers: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"],
    },
    {
      mode: "api-key" as const,
      names: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
      triggers: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    },
    {
      mode: "keychain-profile" as const,
      names: ["APPLE_KEYCHAIN_PROFILE"],
      triggers: ["APPLE_KEYCHAIN_PROFILE"],
    },
  ];
  const incomplete = notarizationOptions.find(
    ({ names, triggers }) => started(env, triggers) && !complete(env, names)
  );
  if (incomplete) {
    throw new Error(
      `Incomplete macOS notarization credentials for ${incomplete.mode}: ${incomplete.names.join(", ")}`
    );
  }
  const selected = notarizationOptions.find(({ names }) => complete(env, names));
  if (!selected) {
    throw new Error(
      "macOS release notarization requires an Apple ID, App Store Connect API key, or notarytool keychain profile."
    );
  }

  return { identity, notarizationMode: selected.mode };
};

export const macosReleaseBuilderArgs = (identity: string): string[] => [
  "--mac",
  "--publish",
  "never",
  "-c.forceCodeSigning=true",
  `-c.mac.identity=${identity}`,
  "-c.mac.hardenedRuntime=true",
  "-c.mac.notarize=true",
  `-c.mac.entitlements=${MACOS_RELEASE_ENTITLEMENTS}`,
  `-c.mac.entitlementsInherit=${MACOS_RELEASE_ENTITLEMENTS}`,
];
