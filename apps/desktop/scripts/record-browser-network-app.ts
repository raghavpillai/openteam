/** Records the actual full OpenTeam renderer against inert, loopback-only UI fixtures. */
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "../../output/browser-network-compact");
await mkdir(output, { recursive: true });
const backend = "http://127.0.0.1:19995";
const post = async (path: string, body: unknown = {}) =>
  fetch(backend + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
await post("/__qa/reset");
await post("/__qa/browser-network", {
  sourceOrder: ["mini", "server"],
  devices: [{ machineId: "air", sharingAllowed: false }],
});
const vite = await createServer({
  root,
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    proxy: { "/api": { target: backend, ws: true }, "/__qa": { target: backend } },
  },
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
  colorScheme: "light",
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => void dialog.accept());
await page.addInitScript(() => {
  localStorage.setItem("openteam:theme", "light");
  const sharing = async () => {
    const value = await (
      await fetch("/__qa/browser-network", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    return {
      supported: true,
      connected: true,
      sharingAllowed: value.devices[0].sharingAllowed,
      providing: value.runtime.activeMachineId === "air",
      serverUrl: "https://my.openteam.app",
      deploymentId: value.settings.deploymentId,
      activeConnections: 0,
    };
  };
  (window as any).openteam = {
    platform: "darwin",
    auth: {
      readToken: async () => ({ token: null, durable: true, warning: null }),
      writeToken: async () => ({ token: null, durable: true, warning: null }),
      clearToken: async () => ({ token: null, durable: true, warning: null }),
      connectMachine: async () => ({ machineId: "air" }),
      machineStatus: async () => ({
        machineId: "air",
        configured: true,
        connected: true,
        error: null,
      }),
    },
    versions: { electron: "43.4.1", chrome: "146", app: "0.0.4" },
    onNotificationClick: () => () => {},
    onMenuAction: () => () => {},
    notifications: {
      sync: () => {},
      clear: () => {},
      setVisibleChannel: () => {},
      status: async () => ({ supported: true, platform: "darwin", delivered: [] }),
    },
    microphone: {
      status: async () => ({
        permission: "not-determined",
        canOpenSettings: false,
        canRequestPermission: false,
      }),
    },
    updates: {
      serverStatus: async () => ({
        currentVersion: "0.0.4",
        apiProtocolVersion: 2,
        minimumClientVersion: "0.0.4",
        maximumClientVersionExclusive: null,
        recommendedClientVersion: "0.0.4",
        status: "ready",
        updaterAvailable: false,
        message: null,
      }),
      onServerProgress: () => () => {},
      onClientProgress: () => () => {},
      status: async () => ({ status: "up-to-date", currentVersion: "0.0.4" }),
      check: async () => ({ status: "up-to-date" }),
    },
    computer: {
      network: sharing,
      shareNetwork: async (enabled: boolean) => {
        const value = await (
          await fetch("/__qa/browser-network", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).json();
        const sourceOrder = [...value.settings.sourceOrder];
        if (enabled && !sourceOrder.includes("air"))
          sourceOrder.splice(sourceOrder.indexOf("server"), 0, "air");
        await fetch("/__qa/browser-network", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            devices: [{ machineId: "air", sharingAllowed: enabled }],
            ...(!value.settings.sourceOrder.includes("air") && enabled ? { sourceOrder } : {}),
          }),
        });
        return sharing();
      },
      get: async () => ({
        version: 1,
        machine: { machineId: "air", label: "MacBook Air" },
        machineLabel: "MacBook Air",
      }),
    },
  };
});
async function drag(from: string, to: string) {
  const source = await page.locator(`[data-network-source="${from}"] .bn-handle`).boundingBox();
  const target = await page.locator(`[data-network-source="${to}"] .bn-handle`).boundingBox();
  if (!source || !target) throw Error("Missing handle");
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
  await page.goto(vite.resolvedUrls!.local[0]);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: resolve(output, "app-start.png") });
  await page.locator("[data-sidebar-account-trigger]").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Server", exact: true }).click();
  await page.getByRole("list", { name: "Connection priority" }).waitFor();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve(output, "desktop-full-app.png") });
  await page.getByRole("checkbox", { name: "Route browser traffic through this computer" }).click();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Route browser traffic through this computer"]'
        ) as HTMLInputElement
      )?.checked
  );
  await page.locator('[data-network-source="air"]').waitFor();
  await page.waitForTimeout(2000);
  await drag("air", "mini");
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Using MacBook Air" }).waitFor();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Test active connection" }).click();
  await page.getByLabel("Latency 42 milliseconds", { exact: true }).waitFor();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve(output, "desktop-air-active.png") });
  await page.getByRole("button", { name: "Reveal exit IP" }).click();
  await page.waitForTimeout(1400);
  await page.getByRole("button", { name: "Reveal exit location" }).click();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Hide exit IP" }).click();
  await page.getByRole("button", { name: "Hide exit location" }).click();
  await page.getByRole("checkbox").click();
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          'input[aria-label="Route browser traffic through this computer"]'
        ) as HTMLInputElement
      )?.checked
  );
  await page.getByRole("status").filter({ hasText: "Using Mac mini" }).waitFor();
  await page.waitForTimeout(2000);
  await drag("server", "mini");
  await page.waitForTimeout(1600);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Using the server connection" }).waitFor();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: resolve(output, "desktop-server-active.png") });
  if (errors.length) throw Error(errors.join("\n"));
  const video = page.video()!;
  await context.close();
  await video.saveAs(resolve(output, "desktop-full-app.webm"));
  await writeFile(
    resolve(output, "desktop-recording-result.json"),
    JSON.stringify({
      passed: true,
      pageErrors: errors,
      recorded: "full production renderer; inert device fixtures",
    })
  );
  console.log("Full-app recording passed");
} finally {
  await context.close();
  await browser.close();
  // Loopback event polls may leave proxy sockets open after the page closes.
  vite.httpServer?.closeAllConnections();
  await vite.close();
}
