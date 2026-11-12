import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "widget-parity",
  runner: "widget-group-parity-runner.cjs",
  page: "widget-group-parity.html",
  env: (dir, url) => ({ DESKTOP_PARITY_DIR: dir, DESKTOP_PARITY_URL: url }),
  timeoutMs: 90_000,
});
