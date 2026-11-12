import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "background-activity",
  runner: "background-activity-runner.cjs",
  page: "background-activity.html",
  env: (dir, url) => ({ BACKGROUND_ACTIVITY_DIR: dir, BACKGROUND_ACTIVITY_URL: url }),
  timeoutMs: 30_000,
});
