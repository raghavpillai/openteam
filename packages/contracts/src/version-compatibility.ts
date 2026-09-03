export const OPENTEAM_API_PROTOCOL_VERSION = 1;

export interface OpenTeamClientCompatibilityPolicy {
  minimumClientVersion?: string | null;
  maximumClientVersionExclusive?: string | null;
  recommendedClientVersion?: string | null;
  minimumServerVersion?: string | null;
}

interface ParsedOpenTeamVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  normalized: string;
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const parseOpenTeamVersion = (value: string | null | undefined): ParsedOpenTeamVersion | null => {
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

const compareParsedVersions = (
  left: ParsedOpenTeamVersion,
  right: ParsedOpenTeamVersion
): number => {
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

export const normalizeOpenTeamVersion = (value: string): string | null =>
  parseOpenTeamVersion(value)?.normalized ?? null;

export const isOpenTeamVersion = (value: string): boolean =>
  normalizeOpenTeamVersion(value) !== null;

export const compareOpenTeamVersions = (left: string, right: string): number | null => {
  const a = parseOpenTeamVersion(left);
  const b = parseOpenTeamVersion(right);
  return a && b ? compareParsedVersions(a, b) : null;
};

/** Patch releases in the same minor line are compatible unless a release widens the window. */
export const defaultOpenTeamCompatibilityWindow = (
  releaseVersion: string
): { minimum: string; maximumExclusive: string } | null => {
  const parsed = parseOpenTeamVersion(releaseVersion);
  if (!parsed) return null;
  return {
    minimum: `${parsed.major}.${parsed.minor}.0`,
    maximumExclusive: `${parsed.major}.${parsed.minor + 1}.0`,
  };
};

export type OpenTeamCompatibilityState =
  | "compatible"
  | "update-recommended"
  | "client-update-required"
  | "server-update-required"
  | "unknown";

export const openTeamCompatibility = (
  clientVersion: string,
  serverVersion: string | null,
  serverProtocolVersion: number | null = OPENTEAM_API_PROTOCOL_VERSION,
  policy: OpenTeamClientCompatibilityPolicy = {}
): OpenTeamCompatibilityState => {
  const client = parseOpenTeamVersion(clientVersion);
  const server = parseOpenTeamVersion(serverVersion);
  if (!client || !server || !Number.isInteger(serverProtocolVersion)) return "unknown";

  if ((serverProtocolVersion as number) > OPENTEAM_API_PROTOCOL_VERSION) {
    return "client-update-required";
  }
  if ((serverProtocolVersion as number) < OPENTEAM_API_PROTOCOL_VERSION) {
    return "server-update-required";
  }

  const serverWindow = defaultOpenTeamCompatibilityWindow(server.normalized);
  const clientWindow = defaultOpenTeamCompatibilityWindow(client.normalized);
  const minimumClient = parseOpenTeamVersion(
    policy.minimumClientVersion ?? serverWindow?.minimum ?? ""
  );
  const maximumClient = parseOpenTeamVersion(
    policy.maximumClientVersionExclusive ?? serverWindow?.maximumExclusive ?? ""
  );
  const minimumServer = parseOpenTeamVersion(
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
