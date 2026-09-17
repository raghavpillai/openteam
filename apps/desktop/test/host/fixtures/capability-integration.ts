import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { CapabilitySettingsStore } from "../../../src/main/host/capability-settings";
import { SavedCredentials } from "../../../src/main/host/credentials";
import { HostCapabilities } from "../../../src/main/host/capabilities";
import { NativeActionReceipts } from "../../../src/main/host/action-receipts";
import { MacMessages } from "../../../src/main/host/messages";
import { sqliteRows, nativeCommand } from "../../../src/main/host/native-command";
import { startHostBridge } from "../../../src/main/host/bridge";
import { BrowserUseSession } from "../../../../computer/src/browser/use";
import { outOfProcessPlaywright } from "../../../../computer/src/browser/playwright-driver";
const root = await mkdtemp(join(tmpdir(), "openteam-native-e2e-"));
let chrome: ReturnType<typeof spawn> | undefined;
let bridge: Awaited<ReturnType<typeof startHostBridge>> | undefined;
let driver: Awaited<ReturnType<typeof outOfProcessPlaywright>> | undefined;
try {
  const db = new Database(join(root, "fixture.db"));
  db.exec(
    "CREATE TABLE fixture(id INTEGER,text TEXT);INSERT INTO fixture VALUES(1,'synthetic 🦊')"
  );
  db.close(true);
  assert.deepEqual(
    await sqliteRows(nativeCommand, join(root, "fixture.db"), "SELECT * FROM fixture"),
    [{ id: 1, text: "synthetic 🦊" }]
  );
  const settings = new CapabilitySettingsStore(join(root, "settings.json"));
  await settings.update({ account: "fixture-account", vault: "fixture-vault" });
  const item = {
    id: "login",
    title: "Fixture login",
    category: "LOGIN",
    updated_at: "1",
    urls: [{ href: "http://127.0.0.1:19999/login" }],
  };
  let reviews = 0;
  let sends = 0;
  const consent = async () => {
    reviews++;
    return "once" as const;
  };
  const credentials = new SavedCredentials(settings, consent, async (_file, args) =>
    args[1] === "list"
      ? JSON.stringify([item])
      : args[1] === "get"
        ? JSON.stringify({
            ...item,
            fields: [
              { purpose: "USERNAME", value: "synthetic-user" },
              { purpose: "PASSWORD", value: "synthetic-password-123" },
            ],
          })
        : "{}"
  );
  const messages = {
    execute: async (name: string) => {
      if (name === "SendIMessage") {
        sends++;
        return { submitted: true, verified: true };
      }
      return { kind: "fixture" };
    },
  } as unknown as MacMessages;
  const capabilities = new HostCapabilities(
    settings,
    consent,
    messages,
    credentials,
    undefined,
    "darwin",
    new NativeActionReceipts(join(root, "receipts.json"))
  );
  bridge = await startHostBridge({
    token: "synthetic-bridge-token",
    port: 0,
    terminalDir: root,
    permissionSettings: { read: async () => ({ localToolPermission: "ask" }) } as never,
    autoReviewMode: "enforce",
    reviewAction: async () => ({ decision: "allow", reason: "fixture" }) as never,
    runJob: async () => {
      throw new Error("No host jobs allowed in fixture");
    },
    capabilities,
  });
  const address = bridge.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}/v1/capabilities`;
  const call = async (tool: string, args: unknown = {}, callId = crypto.randomUUID()) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-bridge-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool, botId: "fixture-bot", callId, arguments: args }),
    });
    const result = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  assert.equal((await fetch(endpoint, { method: "POST", body: "{}" })).status, 401);
  const list = await call("ListCredentials", { site: "http://127.0.0.1:19999" });
  assert.equal(list.credentials.length, 1);
  assert(!JSON.stringify(list).includes("synthetic-password"));
  const login = list.credentials[0];
  assert.deepEqual(await call("AutomaticSavedCredential", { site: "http://127.0.0.1:19999" }), {
    skipped: true,
  });
  await settings.update({ autoFill: [`${login.connection_id}:${login.credential_id}`] });
  const automatic = await call("AutomaticSavedCredential", { site: "http://127.0.0.1:19999" });
  assert.equal(automatic.password, "synthetic-password-123");
  assert.equal(reviews, 0);
  const profile = join(root, "chromium");
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let port = "";
  for (let i = 0; i < 100; i++) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert(port);
  driver = await outOfProcessPlaywright();
  const connection = await driver.playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = connection.contexts()[0]!.pages()[0]!;
  await page.route("http://127.0.0.1:19999/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><form><input name="username"><input type="password"><button>Sign in</button></form></html>',
    })
  );
  await page.goto("http://127.0.0.1:19999/login");
  const browser = await BrowserUseSession.connect(`http://127.0.0.1:${port}`, root, true);
  const stale = await browser.loginBinding(automatic.origin);
  await page.reload();
  assert.equal(await browser.fillSavedLogin(stale, automatic), false);
  await browser.releaseLoginBinding(stale);
  const binding = await browser.loginBinding(automatic.origin);
  assert.equal(await browser.fillSavedLogin(binding, automatic), true);
  await browser.releaseLoginBinding(binding);
  assert.equal(await page.locator('input[type="password"]').inputValue(), automatic.password);
  const snapshot = await browser.execute("browser_snapshot", {});
  assert(!JSON.stringify(snapshot).includes(automatic.password));
  assert(!JSON.stringify(snapshot).includes(automatic.username));
  await assert.rejects(
    browser.execute("browser_cdp", {
      method: "Runtime.evaluate",
      params: { expression: 'document.querySelector("input").value' },
    }),
    /private login data/
  );
  assert.deepEqual(
    await browser.importPrivateCookies([
      {
        name: "fixture",
        value: "synthetic-cookie",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
      },
    ]),
    { injected: 1, failed: 0 }
  );
  assert(
    (await connection.contexts()[0]!.cookies()).some(
      (cookie) => cookie.name === "fixture" && cookie.value === "synthetic-cookie"
    )
  );
  const sendId = crypto.randomUUID();
  const send = { text: "Synthetic send; never dispatched to Messages", to: "+15555550100" };
  await call("SendIMessage", send, sendId);
  await call("SendIMessage", send, sendId);
  assert.equal(sends, 1);
  await settings.update({ revoke: "credentials" });
  assert.deepEqual(await call("AutomaticSavedCredential", { site: automatic.origin }), {
    skipped: true,
  });
  console.log(
    "PASS native SQLite + authenticated desktop bridge + Chrome document binding/autofill/cookies + send replay (synthetic data)"
  );
} finally {
  if (bridge) {
    bridge.closeAllConnections();
    await new Promise<void>((resolve) => bridge!.close(() => resolve()));
  }
  await driver?.stop();
  chrome?.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
