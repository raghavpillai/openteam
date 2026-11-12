import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "parity-edges",
  runner: "desktop-parity-edges-runner.cjs",
  page: `desktop-parity-edges.html${process.argv.includes("--drafts") ? "?draft-review" : ""}`,
  env: (dir, url) => ({ DESKTOP_PARITY_DIR: dir, DESKTOP_PARITY_URL: url }),
  timeoutMs: 90_000,
});
