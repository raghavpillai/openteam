// Desktop self-update (sidebar badge, ready dialog, Settings) and server update
// (busy bots, confirmation, progress, reconnect and reopen) against synthetic fixtures.
import { runAndPrint } from "../test/browser/run-electron-fixture";

for (const [runner, page] of [
  ["desktop-update-driver.cjs", "desktop-update.html"],
  ["computer-update-driver.cjs", "computer-update.html"],
])
  await runAndPrint({
    name: "update-ui",
    runner,
    page,
    env: (dir, url) => ({ UPDATE_UI_DIR: dir, UPDATE_UI_URL: url }),
    timeoutMs: 60_000,
  });
