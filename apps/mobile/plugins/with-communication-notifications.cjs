const { withXcodeProject, withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");
const NAME = "OpenTeamNotificationService";
const CAPABILITY = "com.apple.developer.usernotifications.communication";

function configureProject(project, { bundleIdentifier, version, buildNumber }) {
  let target = Object.entries(project.pbxNativeTargetSection()).find(
    ([, value]) =>
      value && typeof value === "object" && String(value.name).replaceAll('"', "") === NAME
  );
  if (!target) {
    const added = project.addTarget(
      NAME,
      "app_extension",
      NAME,
      `${bundleIdentifier}.notifications`
    );
    target = [added.uuid, added.pbxNativeTarget];
    project.addBuildPhase(
      [
        "../notification-service/NotificationService.swift",
        "../notification-service/RobotNotificationAvatar.swift",
      ],
      "PBXSourcesBuildPhase",
      "Sources",
      added.uuid
    );
    project.addBuildPhase(
      ["../notification-service/RobotArtwork.json"],
      "PBXResourcesBuildPhase",
      "Resources",
      added.uuid
    );
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", added.uuid);
  }
  const configurations =
    project.pbxXCConfigurationList()[target[1].buildConfigurationList].buildConfigurations;
  const host = project.getFirstTarget().firstTarget;
  const hostList =
    project.pbxXCConfigurationList()[host.buildConfigurationList].buildConfigurations;
  for (const ref of configurations) {
    const configuration = project.pbxXCBuildConfigurationSection()[ref.value];
    const hostConfiguration = hostList
      .map((ref) => project.pbxXCBuildConfigurationSection()[ref.value])
      .find((item) => item.name === configuration.name);
    Object.assign(configuration.buildSettings, {
      INFOPLIST_FILE: '"../notification-service/Info.plist"',
      CODE_SIGN_ENTITLEMENTS: '"../notification-service/NotificationService.entitlements"',
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}.notifications"`,
      IPHONEOS_DEPLOYMENT_TARGET: "16.4",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: "YES",
      GENERATE_INFOPLIST_FILE: "NO",
      CURRENT_PROJECT_VERSION: String(buildNumber || "1"),
      MARKETING_VERSION: version || "1.0",
      CODE_SIGN_STYLE: "Automatic",
      ...(hostConfiguration?.buildSettings.DEVELOPMENT_TEAM
        ? { DEVELOPMENT_TEAM: hostConfiguration.buildSettings.DEVELOPMENT_TEAM }
        : {}),
    });
  }
  return project;
}

module.exports = function withCommunicationNotifications(config) {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults[CAPABILITY] = true;
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults.NSUserActivityTypes = [
      ...new Set([...(c.modResults.NSUserActivityTypes || []), "INSendMessageIntent"]),
    ];
    return c;
  });
  const extra = (config.extra ||= {});
  const eas = (extra.eas ||= {});
  const build = (eas.build ||= {});
  const experimental = (build.experimental ||= {});
  const ios = (experimental.ios ||= {});
  ios.appExtensions = [
    ...(ios.appExtensions || []).filter((item) => item.targetName !== NAME),
    {
      targetName: NAME,
      bundleIdentifier: `${config.ios.bundleIdentifier}.notifications`,
      entitlements: { [CAPABILITY]: true },
    },
  ];
  return withXcodeProject(config, (c) => {
    configureProject(c.modResults, {
      bundleIdentifier: c.ios.bundleIdentifier,
      version: c.version,
      buildNumber: c.ios.buildNumber,
    });
    return c;
  });
};
module.exports.configureProject = configureProject;
