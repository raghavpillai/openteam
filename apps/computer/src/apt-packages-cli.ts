// Run by apt's hooks (snapshot, record) and the computer entrypoint (replay); see apt-packages.ts.
import { recordAfterApt, replayRecordedPackages, snapshotBeforeApt } from "./apt-packages";

const command = process.argv[2];
const action = command === "snapshot" ? snapshotBeforeApt : command === "record" ? recordAfterApt : command === "replay" ? replayRecordedPackages : null;
if (!action) {
  console.error("usage: apt-packages-cli.js snapshot|record|replay");
  process.exitCode = 2;
} else {
  // A failure here must never fail the apt run or the computer's start.
  await action().catch((error) => console.error(`openteam apt ${command}: ${error instanceof Error ? error.message : String(error)}`));
}
