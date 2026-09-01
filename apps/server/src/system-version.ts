import type { SystemVersionView } from "@openbot/contracts";
import {
  defaultOpenBotCompatibilityWindow,
  isOpenBotVersion,
  OPENBOT_API_PROTOCOL_VERSION,
} from "@openbot/contracts/version-compatibility";

export { OPENBOT_API_PROTOCOL_VERSION };
const FALLBACK_RELEASE_VERSION = "0.1.0";

const releaseVersionFrom = (environment: NodeJS.ProcessEnv): string => {
  const candidate = environment.OPENBOT_VERSION?.trim();
  return candidate && isOpenBotVersion(candidate) ? candidate : FALLBACK_RELEASE_VERSION;
};

export const systemVersion = (environment: NodeJS.ProcessEnv = process.env): SystemVersionView => {
  const releaseVersion = releaseVersionFrom(environment);
  const compatibilityWindow = defaultOpenBotCompatibilityWindow(releaseVersion) ?? {
    minimum: releaseVersion,
    maximumExclusive: releaseVersion,
  };
  const minimumClientVersion = environment.OPENBOT_MIN_CLIENT_VERSION?.trim();
  const maximumClientVersionExclusive = environment.OPENBOT_MAX_CLIENT_VERSION_EXCLUSIVE?.trim();
  const recommendedClientVersion = environment.OPENBOT_RECOMMENDED_CLIENT_VERSION?.trim();
  const updateChannel = environment.OPENBOT_UPDATE_CHANNEL === "beta" ? "beta" : "stable";
  return {
    releaseVersion,
    apiProtocolVersion: OPENBOT_API_PROTOCOL_VERSION,
    minimumClientVersion:
      minimumClientVersion && isOpenBotVersion(minimumClientVersion)
        ? minimumClientVersion
        : compatibilityWindow.minimum,
    maximumClientVersionExclusive:
      maximumClientVersionExclusive && isOpenBotVersion(maximumClientVersionExclusive)
        ? maximumClientVersionExclusive
        : compatibilityWindow.maximumExclusive,
    recommendedClientVersion:
      recommendedClientVersion && isOpenBotVersion(recommendedClientVersion)
        ? recommendedClientVersion
        : releaseVersion,
    updateChannel,
  };
};
