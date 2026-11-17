import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";
import type {
  PluginCatalogItemView,
  PluginConnectionView,
  PluginSettingsView,
} from "@openteam/contracts";
import whatsapp from "../../../packages/plugins/whatsapp/plugin.json";

// Real plugin dialog with synthetic HTTP responses; no account, database, or WhatsApp access.
const plugin = {
  ...whatsapp,
  installed: true,
  setupFields: [],
  logoUrl: null,
  sourceUrl: null,
  sourceRevision: null,
  // Older installed WhatsApp manifests still declare optional setup fields.
  setup: {
    ...whatsapp.setup,
    fields: [
      {
        key: "WHATSAPP_READ_ONLY",
        label: "Read-only access",
        type: "boolean",
        default: false,
        required: false,
        secret: false,
      },
      {
        key: "WHATSAPP_MEDIA_ROOT",
        label: "Attachment folder",
        default: "/workspace",
        required: false,
        secret: false,
      },
      {
        key: "WHATSAPP_MAX_MESSAGES",
        label: "Maximum stored messages",
        type: "integer",
        default: 100000,
        required: false,
        secret: false,
      },
    ],
  },
} as PluginCatalogItemView;
const connection: PluginConnectionView = {
  id: "whatsapp-account",
  revision: "1",
  pluginKey: "whatsapp",
  connectorKey: "whatsapp",
  name: "WhatsApp",
  alias: "default",
  transport: "stdio",
  auth: "none",
  status: "disconnected",
  statusMessage: null,
  instructions: "",
  authorizationUrl: null,
  oauthRedirectUrl: null,
  canAuthenticate: false,
  configured: true,
  command: "bun",
  tools: [],
};

const data: PluginSettingsView = {
  catalog: [plugin],
  activity: [],
  botCount: 0,
  installs: [
    {
      id: "whatsapp-install",
      pluginKey: "whatsapp",
      version: plugin.version,
      name: "WhatsApp",
      description: plugin.description,
      publisher: plugin.publisher,
      status: "installed",
      installedAt: new Date(0).toISOString(),
      hasSkills: true,
      configuredEnvironment: [],
      connections: [connection],
    },
  ],
};
const preferences: Record<string, string | number | boolean> = {};
const mutations: { path: string; body: any }[] = [];
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false, hmr: false },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = "http://127.0.0.1:63388";
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    if (!["GET", "OPTIONS"].includes(request.method())) mutations.push({ path, body });
    let result: unknown = {};
    if (request.method() === "OPTIONS") result = {};
    else if (path === "/api/v0/plugins") result = data;
    else if (path.endsWith("/status")) result = { connections: [connection] };
    else if (path.endsWith("/configuration")) {
      if (request.method() === "PUT") Object.assign(preferences, body.values);
      result = {
        connectionId: connection.id,
        fields: plugin.setup!.fields,
        values: preferences,
        setup: plugin.setup,
      };
    } else if (path.endsWith("/restart")) {
      connection.status = "needs_auth";
      connection.deviceLink = {
        sessionId: "synthetic-approval",
        expiresAt: Date.now() + 120000,
        qrCodeDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
        instructions: "Open WhatsApp → Linked devices → Link a device",
      };
      result = { status: "needs_auth" };
    }
    await route.fulfill({
      json: result,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
  });
  await page.goto(
    `${server.resolvedUrls!.local[0]}test/browser/plugin-lifecycle.html?server=${encodeURIComponent(origin)}&reviewPlugin=whatsapp`
  );
  await page.getByRole("button", { name: "Open plugin setup", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Attachment folder", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Set up later" }).count(), 0);
  await page.getByRole("button", { name: "default account settings" }).click();
  await page.getByText("Preferences", { exact: true }).click();
  assert.equal(
    await page.getByLabel("Attachment folder", { exact: true }).inputValue(),
    "/workspace"
  );
  assert.equal(
    await page.getByLabel("Maximum stored messages", { exact: true }).inputValue(),
    "100000"
  );
  assert.equal(await page.getByLabel("Read-only access", { exact: true }).isChecked(), false);
  await page.getByLabel("Read-only access", { exact: true }).check();
  await page.getByLabel("Maximum stored messages", { exact: true }).fill("5000");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-label="default account settings"]') &&
      !document.querySelector('button[aria-busy="true"]')
  );
  assert.deepEqual(preferences, {
    WHATSAPP_READ_ONLY: true,
    WHATSAPP_MAX_MESSAGES: 5000,
    WHATSAPP_MEDIA_ROOT: "/workspace",
  });
  await page.getByRole("button", { name: "default account settings" }).click();
  const before = mutations.length;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByAltText("Scan to link your account").waitFor();
  assert(mutations.slice(before).some((request) => request.path.endsWith("/restart")));
  assert(!mutations.slice(before).some((request) => request.path.endsWith("/configuration")));
  assert.equal(await page.getByRole("button", { name: "Set up later" }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: WhatsApp opens QR linking without a setup form; optional preferences stay in account settings and save typed values."
  );
} finally {
  await browser.close();
  await server.close();
}
