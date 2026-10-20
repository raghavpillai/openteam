/** Real settings panel; deterministic HTTP readings exercise colors and polling lifecycle.
 * Run: bun apps/desktop/scripts/test-server-activity.ts
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication } from "../../computer/node_modules/playwright-core";
import { createServer } from "vite";

const repo = resolve(import.meta.dir, "../../..");
const output = resolve(repo, "output/server-activity");
await mkdir(output, { recursive: true });
const vite = await createServer({
  root: resolve(repo, "apps/desktop"),
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const profile = await mkdtemp(join(tmpdir(), "openteam-server-activity-"));
let browser: ElectronApplication | undefined;
try {
  const preload = await Bun.build({
    entrypoints: [resolve(repo, "apps/desktop/src/preload/index.ts")],
    target: "node",
    format: "cjs",
    external: ["electron"],
    outdir: profile,
    naming: "preload.cjs",
  });
  if (!preload.success) throw new Error("Could not build the desktop preload");
  browser = await _electron.launch({
    timeout: 45_000,
    executablePath: process.env.ELECTRON_PATH || createRequire(import.meta.url)("electron"),
    args: [resolve(repo, "apps/desktop/test/browser/server-activity-runner.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SERVER_ACTIVITY_PROFILE: profile },
  });
  const page = await browser.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let count = 0;
  let fail = false;
  let reading = { cpuPercent: 32, memoryPercent: 76, diskPercent: 94 };
  await page.route("**/api/v0/system/activity", async (route) => {
    count++;
    await route.fulfill({
      status: fail ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify({ ...reading, sampledAt: new Date().toISOString() }),
    });
  });
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    console.log(`PASS ${message}`);
  };
  await page.goto(`${vite.resolvedUrls!.local[0]}test/browser/server-activity.html`);
  await page.getByRole("button", { name: "Server", exact: true }).click();
  await page.getByRole("img", { name: "CPU: 32% used", exact: true }).waitFor();
  assert((await page.getByRole("img", { name: "RAM: 76% used" }).count()) === 1, "RAM reading");
  assert((await page.getByRole("img", { name: "Disk: 94% used" }).count()) === 1, "Disk reading");
  await page.getByRole("dialog").screenshot({ path: resolve(output, "desktop-light.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByRole("dialog").screenshot({ path: resolve(output, "desktop-dark.png") });
  const initial = count;
  await page.waitForTimeout(5_200);
  assert(count === initial + 1, "refreshes every five seconds");
  fail = true;
  await page.getByText("Unavailable · retrying").waitFor({ timeout: 6_000 });
  assert(
    (await page.getByRole("img", { name: "CPU: unavailable" }).count()) === 1,
    "failure clears stale readings"
  );
  fail = false;
  reading = { cpuPercent: 0, memoryPercent: 100, diskPercent: 69 };
  await page.getByRole("img", { name: "CPU: 0% used", exact: true }).waitFor({ timeout: 6_000 });
  assert(
    (await page.getByRole("img", { name: "RAM: 100% used" }).count()) === 1,
    "recovers and renders endpoints"
  );
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("region", { name: "Live server activity" }).waitFor({ state: "detached" });
  const away = count;
  await page.waitForTimeout(5_200);
  assert(count === away, "no activity requests outside the server panel");
  await page.getByRole("button", { name: "Server", exact: true }).click();
  await page.getByRole("img", { name: "CPU: 0% used", exact: true }).waitFor();
  await browser.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
  await page.getByText("Paused", { exact: true }).waitFor();
  const hidden = count;
  await page.waitForTimeout(5_200);
  assert(count === hidden, "no activity requests while backgrounded");
  await browser.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
  await page.getByText("Every 5 seconds", { exact: true }).waitFor();
  assert(count === hidden + 1, "refreshes immediately on foreground");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("region", { name: "Live server activity" }).waitFor({ state: "detached" });
  const closed = count;
  await page.waitForTimeout(5_200);
  assert(count === closed, "closing settings stops activity requests");
  assert(errors.length === 0, `no renderer errors: ${errors.join(", ")}`);
} finally {
  await browser?.close();
  await vite.close();
  await rm(profile, { recursive: true, force: true });
}
