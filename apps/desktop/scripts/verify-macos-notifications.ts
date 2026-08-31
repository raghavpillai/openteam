import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "darwin") {
  throw new Error("macOS notification signing can only be verified on macOS");
}

const packageRoot = resolve(import.meta.dir, "..");
const releaseRoot = resolve(packageRoot, "release");
const args = Bun.argv.slice(2);
const allowAdHoc = args.includes("--allow-adhoc");
const requestedArg = args.find((arg) => arg !== "--allow-adhoc");
const requested = requestedArg ? resolve(requestedArg) : null;
const requestedIsDirectory = Boolean(
  requested && existsSync(requested) && statSync(requested).isDirectory()
);
const searchRoot = requestedIsDirectory && requested ? requested : releaseRoot;
const discovered = existsSync(searchRoot)
  ? readdirSync(searchRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith("OpenBot.app"))
      .map((entry) => resolve(searchRoot, String(entry)))
  : [];
const appPath = requested && !requestedIsDirectory ? requested : discovered[0];
if (!appPath || !existsSync(appPath)) {
  throw new Error("OpenBot.app was not found. Build the macOS package first.");
}

const verify = Bun.spawnSync([
  "codesign",
  "--verify",
  "--deep",
  "--strict",
  "--verbose=2",
  appPath,
]);
if (verify.exitCode !== 0) {
  throw new Error(`OpenBot.app is not validly signed:\n${verify.stderr.toString().trim()}`);
}

const details = Bun.spawnSync(["codesign", "-dv", "--verbose=4", appPath]);
const output = `${details.stdout.toString()}\n${details.stderr.toString()}`;
if (!output.includes("Identifier=dev.openbot.desktop")) {
  throw new Error(`Unexpected signing identifier:\n${output.trim()}`);
}
const isAdHoc = output.includes("Signature=adhoc");
if (!allowAdHoc && isAdHoc) {
  throw new Error("OpenBot.app is only ad-hoc signed; release builds require a Developer ID.");
}
if (!allowAdHoc && !/TeamIdentifier=(?!not set)\S+/.test(output)) {
  throw new Error(
    "OpenBot.app has no Apple Team identifier; notification events are not reliable."
  );
}
if (allowAdHoc && !isAdHoc && !/TeamIdentifier=(?!not set)\S+/.test(output)) {
  throw new Error("OpenBot.app has neither a Developer ID nor an ad-hoc signature.");
}

if (!allowAdHoc) {
  const assessment = Bun.spawnSync([
    "spctl",
    "--assess",
    "--type",
    "execute",
    "--verbose=2",
    appPath,
  ]);
  if (assessment.exitCode !== 0) {
    throw new Error(
      `OpenBot.app is not accepted by Gatekeeper:\n${assessment.stderr.toString().trim()}`
    );
  }
}

const plist = resolve(appPath, "Contents", "Info.plist");
const bundleId = Bun.spawnSync([
  "plutil",
  "-extract",
  "CFBundleIdentifier",
  "raw",
  "-o",
  "-",
  plist,
]);
if (bundleId.exitCode !== 0 || bundleId.stdout.toString().trim() !== "dev.openbot.desktop") {
  throw new Error(
    "The packaged app does not have the stable dev.openbot.desktop bundle identifier."
  );
}

console.log(
  `Verified ${isAdHoc ? "local ad-hoc" : "release"} macOS notification identity: ${appPath}`
);
