import { join, resolve } from "node:path";
import { runElectronFixture } from "../test/browser/run-electron-fixture";

const directory = resolve(
  process.env.TAILSCALE_QA_DIR ?? resolve(import.meta.dir, "../../../output/tailscale-settings-qa")
);
const result = await runElectronFixture({
  name: "tailscale-settings",
  runner: "tailscale-settings-runner.cjs",
  page: "tailscale-settings.html",
  env: (dir, url) => ({ TAILSCALE_QA_DIR: dir, TAILSCALE_QA_URL: url }),
  timeoutMs: 40_000,
  directory,
});
for (const report of result.reports) console.log(`PASS ${report}`);
console.log(`Screenshot: ${join(directory, "settings.png")}`);
