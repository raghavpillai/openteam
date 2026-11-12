// Search palette and Create Bot panel checks; both runners share one fixture page.
import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "panel-parity",
  runner: "panel-parity-runner.cjs",
  page: "panel-parity.html",
  env: (dir, url) => ({ PANEL_TEST_DIR: dir, PANEL_TEST_URL: url }),
  timeoutMs: 45_000,
});
await runAndPrint({
  name: "search-parity",
  runner: "search-parity-runner.cjs",
  page: "panel-parity.html",
  env: (dir, url) => ({ SEARCH_TEST_DIR: dir, SEARCH_TEST_URL: url }),
  timeoutMs: 90_000,
});
