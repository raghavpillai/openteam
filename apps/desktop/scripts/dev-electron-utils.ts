export const ELECTRON_BUNDLE_ARTIFACTS = [
  "main.js",
  "chunks/index.js",
  "chunks/main.js",
  "host-utility.js",
  "preload.cjs",
] as const;

export interface DevElectronEnvironment {
  host: string;
  rendererUrl: string;
  waitResource: string;
}

type DevEnvironmentInput = Partial<
  Record<"OPENTEAM_DEV_HOST" | "OPENTEAM_RENDERER_URL", string | undefined>
>;

const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

const rendererHost = (host: string) =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const resolveDevElectronEnvironment = (
  environment: DevEnvironmentInput
): DevElectronEnvironment => {
  const host = nonEmpty(environment.OPENTEAM_DEV_HOST) ?? "127.0.0.1";
  const rendererUrl =
    nonEmpty(environment.OPENTEAM_RENDERER_URL) ?? `http://${rendererHost(host)}:5173`;

  return {
    host,
    rendererUrl,
    waitResource: `tcp:${host}:5173`,
  };
};

export const isElectronBundleArtifact = (filename: string | Buffer | null) => {
  if (filename === null) return true;
  const value = (typeof filename === "string" ? filename : filename.toString()).replaceAll(
    "\\",
    "/"
  );
  return ELECTRON_BUNDLE_ARTIFACTS.includes(value as (typeof ELECTRON_BUNDLE_ARTIFACTS)[number]);
};
