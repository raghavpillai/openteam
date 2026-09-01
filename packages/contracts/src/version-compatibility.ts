export const OPENBOT_API_PROTOCOL_VERSION = 1;

export interface OpenBotClientCompatibilityPolicy {
  minimumClientVersion?: string | null;
  maximumClientVersionExclusive?: string | null;
  recommendedClientVersion?: string | null;
  minimumServerVersion?: string | null;
}

interface ParsedOpenBotVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  normalized: string;
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const parseOpenBotVersion = (value: string | null | undefined): ParsedOpenBotVersion | null => {
  if (!value) return null;
  const match = value.trim().match(VERSION_PATTERN);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  const normalized = `${major}.${minor}.${patch}${
    prerelease.length ? `-${prerelease.join(".")}` : ""
  }`;
  return {
    major,
    minor,
    patch,
    prerelease,
    normalized,
  };
};

const compareNumericIdentifiers = (left: string, right: string) =>
  left.length === right.length ? (left < right ? -1 : 1) : left.length - right.length;

const compareParsedVersions = (left: ParsedOpenBotVersion, right: ParsedOpenBotVersion): number => {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return compareNumericIdentifiers(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
};

export const normalizeOpenBotVersion = (value: string): string | null =>
  parseOpenBotVersion(value)?.normalized ?? null;

export const isOpenBotVersion = (value: string): boolean => normalizeOpenBotVersion(value) !== null;

export const compareOpenBotVersions = (left: string, right: string): number | null => {
  const a = parseOpenBotVersion(left);
  const b = parseOpenBotVersion(right);
  return a && b ? compareParsedVersions(a, b) : null;
};

/** Patch releases in the same minor line are compatible unless a release widens the window. */
export const defaultOpenBotCompatibilityWindow = (
  releaseVersion: string
): { minimum: string; maximumExclusive: string } | null => {
  const parsed = parseOpenBotVersion(releaseVersion);
  if (!parsed) return null;
  return {
    minimum: `${parsed.major}.${parsed.minor}.0`,
    maximumExclusive: `${parsed.major}.${parsed.minor + 1}.0`,
  };
};

export type OpenBotCompatibilityState =
  | "compatible"
  | "update-recommended"
  | "client-update-required"
  | "server-update-required"
  | "unknown";

export const openBotCompatibility = (
  clientVersion: string,
  serverVersion: string | null,
  serverProtocolVersion: number | null = OPENBOT_API_PROTOCOL_VERSION,
  policy: OpenBotClientCompatibilityPolicy = {}
): OpenBotCompatibilityState => {
  const client = parseOpenBotVersion(clientVersion);
  const server = parseOpenBotVersion(serverVersion);
  if (!client || !server || !Number.isInteger(serverProtocolVersion)) return "unknown";

  if ((serverProtocolVersion as number) > OPENBOT_API_PROTOCOL_VERSION) {
    return "client-update-required";
  }
  if ((serverProtocolVersion as number) < OPENBOT_API_PROTOCOL_VERSION) {
    return "server-update-required";
  }

  const serverWindow = defaultOpenBotCompatibilityWindow(server.normalized);
  const clientWindow = defaultOpenBotCompatibilityWindow(client.normalized);
  const minimumClient = parseOpenBotVersion(
    policy.minimumClientVersion ?? serverWindow?.minimum ?? ""
  );
  const maximumClient = parseOpenBotVersion(
    policy.maximumClientVersionExclusive ?? serverWindow?.maximumExclusive ?? ""
  );
  const minimumServer = parseOpenBotVersion(
    policy.minimumServerVersion ?? clientWindow?.minimum ?? ""
  );
  if (!minimumClient || !maximumClient || !minimumServer) return "unknown";

  if (compareParsedVersions(client, minimumClient) < 0) return "client-update-required";
  if (
    compareParsedVersions(client, maximumClient) >= 0 ||
    compareParsedVersions(server, minimumServer) < 0
  ) {
    return "server-update-required";
  }
  return client.normalized === server.normalized ? "compatible" : "update-recommended";
};
