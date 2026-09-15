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
  const { uuid: hostId, firstTarget: host } = project.getFirstTarget();
  // xcode.addTarget silently skips the dependency when these sections do not
  // exist yet. EAS discovers and signs extensions through this dependency.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ||= {};
  const dependencies = objects.PBXTargetDependency;
  objects.PBXContainerItemProxy ||= {};
  if (!host.dependencies.some((ref) => dependencies[ref.value]?.target === target[0])) {
    project.addTargetDependency(hostId, [target[0]]);
  }
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
  config.extra ||= {};
  const extra = config.extra;
  extra.eas ||= {};
  const eas = extra.eas;
  eas.build ||= {};
  const build = eas.build;
  build.experimental ||= {};
  const experimental = build.experimental;
  experimental.ios ||= {};
  const ios = experimental.ios;
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
