/** Real settings UI, isolated recording API; never changes a running installation. */
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";

const root = resolve(import.meta.dir, "..");
const output = process.env.NOTIFICATION_QA_OUTPUT ?? "/tmp/openteam-smart-notifications-ui";
await mkdir(output, { recursive: true });
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 25213, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  let enabled = true,
    failSave = false,
    oldServer = false,
    revision = 0;
  const writes: boolean[] = [];
  await page.route("**/api/v0/notification-preferences", async (route) => {
    if (oldServer) return route.fulfill({ status: 404, body: "{}" });
    if (route.request().method() === "PATCH") {
      if (failSave)
        return route.fulfill({
          status: 503,
          body: JSON.stringify({ error: { message: "Unavailable" } }),
        });
      enabled = route.request().postDataJSON().smartEnabled;
      writes.push(enabled);
    }
    await route.fulfill({
      json: { smartEnabled: enabled, serverTime: ++revision, iosActiveUntil: 0, macActiveUntil: 0 },
    });
  });
  await page.goto("http://127.0.0.1:25213/test/browser/notification-settings.html");
  const toggle = page.getByRole("switch", {
    name: "Pause alerts on other devices while I’m active",
  });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false"
  );
  assert.deepEqual(writes, [false]);
  failSave = true;
  await toggle.click();
  await page.getByRole("alert").waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  failSave = false;
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true"
  );
  enabled = false; // Preference changed on the other device.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openteam:notification-preferences-changed"))
  );
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false"
  );
  await page.screenshot({ path: resolve(output, "settings.png"), fullPage: true });
  oldServer = true;
  await page.reload();
  await page.waitForTimeout(300);
  assert.equal(await toggle.count(), 0);
  console.log(
    "Passed: default, save, failed save, retry, remote preference sync, older-server fallback."
  );
} finally {
  await browser.close();
  await server.close();
}
