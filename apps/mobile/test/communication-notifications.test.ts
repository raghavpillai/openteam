import { expect, test } from "bun:test";
import { ROBOT_AVATAR_ARTWORK } from "@openteam/design-tokens/robot-avatar-artwork";
import { createRequire } from "node:module";
import { join } from "node:path";

const mobile = join(import.meta.dir, "..");
test("the service extension bundles exactly the profile artwork", async () => {
  expect(await Bun.file(join(mobile, "notification-service/RobotArtwork.json")).json()).toEqual(
    ROBOT_AVATAR_ARTWORK
  );
});

test("the config plugin embeds one extension and keeps signing/version metadata in sync", () => {
  const require = createRequire(join(mobile, "package.json"));
  const cp = createRequire(require.resolve("expo/config-plugins"));
  const xcode = createRequire(cp.resolve("@expo/config-plugins"))("xcode");
  const { configureProject } = require("./plugins/with-communication-notifications.cjs");
  const project = xcode.project(join(mobile, "ios/OpenTeam.xcodeproj/project.pbxproj")).parseSync();
  const options = { bundleIdentifier: "dev.openbot.mobile", version: "1.2.3", buildNumber: "12" };
  configureProject(project, options);
  const first = project.writeSync();
  configureProject(project, options);
  expect(project.writeSync()).toBe(first);
  const targets = Object.values(project.pbxNativeTargetSection()).filter(
    (target: any) => target?.name === '"OpenTeamNotificationService"'
  );
  expect(targets).toHaveLength(1);
  expect(first).toContain("CURRENT_PROJECT_VERSION = 12;");
  expect(first).toContain("APPLICATION_EXTENSION_API_ONLY = YES;");
});
