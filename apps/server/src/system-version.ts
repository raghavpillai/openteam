import type { SystemVersionView } from "@openteam/contracts";
import {
  defaultOpenTeamCompatibilityWindow,
  isOpenTeamVersion,
  OPENTEAM_API_PROTOCOL_VERSION,
} from "@openteam/contracts/version-compatibility";

export { OPENTEAM_API_PROTOCOL_VERSION };
const FALLBACK_RELEASE_VERSION = "0.1.0";

const releaseVersionFrom = (environment: NodeJS.ProcessEnv): string => {
  const candidate = environment.OPENTEAM_VERSION?.trim();
  return candidate && isOpenTeamVersion(candidate) ? candidate : FALLBACK_RELEASE_VERSION;
};

export const systemVersion = (environment: NodeJS.ProcessEnv = process.env): SystemVersionView => {
  const releaseVersion = releaseVersionFrom(environment);
  const compatibilityWindow = defaultOpenTeamCompatibilityWindow(releaseVersion) ?? {
    minimum: releaseVersion,
    maximumExclusive: releaseVersion,
  };
  const minimumClientVersion = environment.OPENTEAM_MIN_CLIENT_VERSION?.trim();
  const maximumClientVersionExclusive = environment.OPENTEAM_MAX_CLIENT_VERSION_EXCLUSIVE?.trim();
  const recommendedClientVersion = environment.OPENTEAM_RECOMMENDED_CLIENT_VERSION?.trim();
  const updateChannel = environment.OPENTEAM_UPDATE_CHANNEL === "beta" ? "beta" : "stable";
  return {
    releaseVersion,
    apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION,
    minimumClientVersion:
      minimumClientVersion && isOpenTeamVersion(minimumClientVersion)
        ? minimumClientVersion
        : compatibilityWindow.minimum,
    maximumClientVersionExclusive:
      maximumClientVersionExclusive && isOpenTeamVersion(maximumClientVersionExclusive)
        ? maximumClientVersionExclusive
        : compatibilityWindow.maximumExclusive,
    recommendedClientVersion:
      recommendedClientVersion && isOpenTeamVersion(recommendedClientVersion)
        ? recommendedClientVersion
        : releaseVersion,
    updateChannel,
  };
};
