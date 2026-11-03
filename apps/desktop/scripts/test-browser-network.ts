import { createServer } from "vite";
import { chromium, type Page } from "../../computer/node_modules/playwright-core";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const output = resolve(root, "../../output/browser-network-compact");
await mkdir(output, { recursive: true });
const context = await browser.newContext({ viewport: { width: 760, height: 820 } });
let checks = 0;
const assert = (value: unknown, message: string) => {
  if (!value) throw Error(message);
  checks++;
};
async function drag(page: Page, from: string, to: string) {
  const source = await page.locator(`[data-network-source="${from}"] .bn-handle`).boundingBox();
  const target = await page.locator(`[data-network-source="${to}"] .bn-handle`).boundingBox();
  if (!source || !target) throw Error("Missing drag handle");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2 + (target.y > source.y ? 8 : -8),
    { steps: 4 }
  );
  await page.waitForTimeout(160);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(300);
}
try {
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.addInitScript(() => {
    (window as any).networkFixture = {
      view: {
        settings: {
          deploymentId: "test-deployment",
          mode: "ranked",
          machineId: null,
          revision: 1,
          sourceOrder: ["office", "server"],
        },
        runtime: {
          state: "ready",
          appliedRevision: 1,
          activeMachineId: "office",
          activeConnections: 0,
          bytesSent: 0,
          bytesReceived: 0,
          blockedConnections: 0,
        },
        devices: [
          {
            machineId: "home",
            label: "MacBook Air",
            enabled: true,
            connected: true,
            sharingAllowed: false,
            supported: true,
          },
          {
            machineId: "office",
            label: "Mac mini",
            enabled: true,
            connected: true,
            sharingAllowed: true,
            supported: true,
          },
        ],
      },
      sharing: {
        supported: true,
        connected: true,
        sharingAllowed: false,
        providing: false,
        serverUrl: "https://openteam.example",
        deploymentId: "test-deployment",
        activeConnections: 0,
      },
      mutations: [],
      permissionChanges: [],
    };
  });
  await page.goto(`${vite.resolvedUrls!.local[0]}test/browser/browser-network.html`);
  const sources = () =>
    page
      .locator("[data-network-source]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-network-source")));
  const status = (text: string) => page.getByRole("status").filter({ hasText: text }).waitFor();
  const apply = () => page.getByRole("button", { name: "Apply", exact: true }).click();
  const keyboardMove = async (name: string, arrow: string, cancel = false) => {
    await page.getByRole("button", { name: `Reorder ${name}`, exact: true }).focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    await page.keyboard.press(arrow);
    await page.waitForTimeout(200);
    await page.keyboard.press(cancel ? "Escape" : "Space");
    await page.waitForTimeout(300);
  };
  await page.getByRole("list", { name: "Connection priority" }).waitFor();
  assert((await page.getByLabel("Browser network source").count()) === 0, "always ranked");
  assert(
    JSON.stringify(await sources()) === JSON.stringify(["office", "server"]),
    "server shares priority pool"
  );
  await page.getByRole("button", { name: "Reveal exit IP", exact: true }).waitFor();
  assert(
    (await page.getByRole("button", { name: "Reveal exit IP" }).getAttribute("aria-pressed")) ===
      "false",
    "IP hidden by default"
  );
  assert(
    (await page.getByText("198.51.100.20", { exact: true }).getAttribute("aria-hidden")) === "true",
    "hidden IP excluded from accessibility tree"
  );
  await page.getByRole("button", { name: "Reveal exit IP" }).click();
  assert(
    (await page.getByText("198.51.100.20", { exact: true }).getAttribute("aria-hidden")) ===
      "false",
    "IP reveals on click"
  );
  await page.getByRole("button", { name: "Hide exit IP" }).press("Enter");
  assert(
    await page.getByRole("button", { name: "Reveal exit IP" }).isVisible(),
    "keyboard hides IP"
  );
  await page.getByRole("button", { name: "Reveal exit location" }).click();
  assert(
    (await page.getByText("Boston, United States").getAttribute("aria-hidden")) === "false",
    "location reveals independently"
  );
  assert(
    await page
      .locator('[data-network-source="office"]')
      .getByLabel("Working · In use", { exact: true })
      .isVisible(),
    "active working device uses a text badge"
  );
  assert(
    (await page.evaluate(() => (window as any).networkFixture.qualityChecks ?? 0)) === 0,
    "speed test never runs automatically"
  );
  await page.getByRole("button", { name: "Test active connection" }).click();
  await page.getByLabel("Latency 42 milliseconds", { exact: true }).waitFor();
  assert(
    await page.getByLabel("Estimated download 28.4 megabits per second").isVisible(),
    "manual exit test shows download estimate"
  );
  assert(
    await page.getByLabel("Estimated upload 9.2 megabits per second").isVisible(),
    "manual exit test shows upload estimate"
  );
  await page.getByRole("checkbox", { name: "Use this computer as network" }).check();
  await page.locator('[data-network-source="home"]').waitFor();
  assert(
    await page
      .locator('[data-network-source="home"]')
      .getByText("(current)", { exact: true })
      .isVisible(),
    "enrolled local computer is identified independently of active route"
  );
  assert(
    JSON.stringify(await sources()) === JSON.stringify(["office", "home", "server"]),
    "opt-in automatically adds device"
  );
  assert(
    (await page.evaluate(() => (window as any).networkFixture.mutations.length)) === 0,
    "no extra Apply for opt-in"
  );
  await drag(page, "home", "office");
  assert((await sources())[0] === "home", "dnd-kit pointer reorders");
  assert(
    (await page.evaluate(() => (window as any).networkFixture.view.runtime.activeMachineId)) ===
      "office",
    "draft does not change active connection"
  );
  await apply();
  await status("Using MacBook Air");
  assert(
    (await page.getByLabel("Latency 42 milliseconds", { exact: true }).count()) === 0,
    "route change clears old speed results"
  );
  await page.getByText("203.0.113.10", { exact: true }).waitFor();
  assert(
    await page.getByRole("button", { name: "Reveal exit location" }).isVisible(),
    "route switch resets location privacy"
  );
  assert(
    (await page.getByText("203.0.113.10", { exact: true }).getAttribute("aria-hidden")) === "true",
    "new route IP hidden"
  );
  await page.getByRole("checkbox").uncheck();
  await status("Using Mac mini");
  assert((await sources())[0] === "home", "stopping sharing retains rank");
  assert(
    await page
      .locator('[data-network-source="home"]')
      .getByText("Not working", { exact: true })
      .isVisible(),
    "stopped device status changes"
  );
  await drag(page, "server", "office");
  assert(
    JSON.stringify(await sources()) === JSON.stringify(["home", "server", "office"]),
    "server pointer reorder"
  );
  await apply();
  await status("Using the server connection");
  await keyboardMove("Server connection", "ArrowUp", true);
  assert(
    JSON.stringify(await sources()) === JSON.stringify(["home", "server", "office"]),
    "Escape cancels keyboard reorder"
  );
  await keyboardMove("Server connection", "ArrowUp");
  assert((await sources())[0] === "server", "keyboard reorders server first");
  await apply();
  await page.getByRole("checkbox").check();
  await status("Using the server connection");
  assert(
    (await sources()).filter((id) => id === "home").length === 1,
    "reenabling never duplicates"
  );
  assert((await sources())[0] === "server", "reenabling respects server first");
  await keyboardMove("Server connection", "ArrowDown");
  await apply();
  await status("Using MacBook Air");
  await keyboardMove("Mac mini", "ArrowUp");
  await page.evaluate(() => {
    const f = (window as any).networkFixture;
    f.view.settings.sourceOrder = ["server", "home", "office"];
    f.view.settings.revision++;
    (window as any).refreshNetworkFixture();
  });
  await apply();
  await page.getByRole("alert").filter({ hasText: "connection changed" }).waitFor();
  assert((await sources())[0] === "server", "stale draft refresh preserves concurrent edit");
  assert(
    (await page.getByRole("button", { name: "Apply", exact: true }).count()) === 0,
    "clean state has no extra actions"
  );
  await page.evaluate(() => {
    const f = (window as any).networkFixture;
    f.failProbe = true;
    f.view.settings.revision++;
  });
  await page.getByText("Unavailable", { exact: true }).waitFor();
  assert(
    (await page.getByRole("button", { name: /Reveal exit/ }).count()) === 0,
    "failed probe never displays stale IP"
  );
  await page.evaluate(() => {
    (window as any).networkFixture.failQuality = true;
  });
  await page.getByRole("button", { name: "Test active connection" }).click();
  await page.getByText("Test unavailable", { exact: true }).waitFor();
  assert(
    (await page.getByLabel("Latency 42 milliseconds", { exact: true }).count()) === 0,
    "failed speed test clears old results"
  );
  await page.setViewportSize({ width: 360, height: 850 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "fits narrow widths"
  );
  await page.screenshot({ path: resolve(output, "compact-component.png"), fullPage: true });
  assert(errors.length === 0, errors.join("\n"));
  console.log(JSON.stringify({ checks, output }));
} finally {
  await context.close();
  await browser.close();
  await vite.close();
}
