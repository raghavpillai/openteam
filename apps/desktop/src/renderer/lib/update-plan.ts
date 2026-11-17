import {
  compareOpenTeamVersions,
  normalizeOpenTeamVersion,
} from "@openteam/contracts/version-compatibility";

/** The release feed and the installed client are independent sources of a server target. */
export function serverUpdateTarget(
  clientVersion: string,
  latestVersion: string | null,
  serverVersion: string | null
) {
  if (!serverVersion) return null;
  const candidates = [clientVersion, latestVersion]
    .map((version) => (version ? normalizeOpenTeamVersion(version) : null))
    .filter((version): version is string => Boolean(version && !version.includes("-")));
  const target = candidates.sort((a, b) => compareOpenTeamVersions(b, a) ?? 0)[0];
  return target && (compareOpenTeamVersions(target, serverVersion) ?? 0) > 0 ? target : null;
}
