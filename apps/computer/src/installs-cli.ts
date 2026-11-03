// `openteam-installs` for bots (status, forget), apt's and dpkg's hooks (snapshot, record,
// dpkg-pre, sources) and the computer entrypoint (replay); see apt-packages.ts and language-packages.ts.
import {
  beforeDpkg,
  describeEntry,
  forgetPackages,
  installsPaths,
  keepSources,
  readForgotten,
  readPackageSnapshot,
  readRecord,
  readReplayStatus,
  recordAfterApt,
  replayRecordedPackages,
  runCommand,
  snapshotBeforeApt,
} from "./apt-packages";
import { currentImage, readSavedImage, rebuildLanguagePackages, saveImage } from "./language-packages";

const [command = "status", ...names] = process.argv.slice(2);
const paths = installsPaths();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function replay() {
  const previous = await readSavedImage(paths);
  const current = await currentImage();
  await replayRecordedPackages({
    afterApt: async (status) => {
      status.languages = await rebuildLanguagePackages(previous, current);
      await saveImage(paths, current);
    },
  });
}

async function status() {
  const [record, forgotten, last, snapshot] = await Promise.all([readRecord(paths), readForgotten(paths), readReplayStatus(paths), readPackageSnapshot(runCommand)]);
  const names = Object.keys(record);
  console.log(names.length
    ? `apt packages the computer reinstalls when it starts (${names.length}):\n${names.map((name) => `  ${describeEntry(name, record[name]!, name in snapshot.installed)}`).join("\n")}`
    : "No apt packages are recorded; the computer reinstalls apt packages installed beyond its image when it starts.");
  const untracked = forgotten.filter((name) => name in snapshot.installed);
  if (untracked.length) console.log(`Forgotten, so not tracked while installed: ${untracked.join(", ")}`);
  if (last) console.log(`Last start: ${last.startedAt}${last.state === "running" ? ", still reinstalling" : `, restored ${last.restored.length}`}. Log: ${paths.log}`);
  console.log("Also kept: the home folder, /workspace and everything under /usr/local. To stop tracking a package (it isn't reinstalled at start, and bots aren't told about it): sudo openteam-installs forget NAME...");
}

async function forget() {
  if (!names.length) throw new Error("usage: sudo openteam-installs forget NAME...");
  if (process.getuid?.() !== 0) throw new Error("run it with sudo: sudo openteam-installs forget " + names.join(" "));
  const { forgotten, unknown } = await forgetPackages(names);
  if (forgotten.length) console.log(`No longer tracked: ${forgotten.join(", ")}. They aren't reinstalled at start, and bots aren't told about them. Removing one and installing it again tracks it again.`);
  if (unknown.length) { console.error(`Not recorded: ${unknown.join(", ")}`); process.exitCode = 1; }
}

const commands: Record<string, () => Promise<unknown>> = {
  snapshot: () => snapshotBeforeApt(),
  record: () => recordAfterApt(),
  "dpkg-pre": () => beforeDpkg(),
  sources: () => keepSources(),
  replay,
  status,
  forget,
};
const hook = ["snapshot", "record", "dpkg-pre", "sources", "replay"].includes(command);
const action = commands[command];
if (!action) {
  console.error("usage: openteam-installs [status] | sudo openteam-installs forget NAME...");
  process.exitCode = 2;
} else {
  await action().catch((error) => {
    // A hook failure must never fail the apt run or the computer's start.
    console.error(`openteam-installs ${command}: ${message(error)}`);
    if (!hook) process.exitCode = 1;
  });
}
