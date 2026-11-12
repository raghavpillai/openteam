// Delivery states, retries and late echoes for sent messages. Pass
// --reduced-motion to run the reduced-motion subset.
import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "send-lifecycle",
  runner: "message-send-lifecycle-runner.cjs",
  page: "message-send-lifecycle.html",
  env: (dir, url) => ({
    SEND_LIFECYCLE_DIR: dir,
    SEND_LIFECYCLE_URL: url,
    SEND_LIFECYCLE_REDUCED_MOTION: process.argv.includes("--reduced-motion") ? "1" : "0",
  }),
  timeoutMs: 90_000,
});
