/** Only synthetic accounts in a disposable DB and loopback OAuth/MCP server. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core";
import { createPluginFlowFixture } from "../../server/test/plugin/fixtures/plugin-flow";
import { createOpenTeamClient } from "../../../packages/client-core/src";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error("OPENTEAM_TEST_DATABASE_URL must name a disposable test database");
const fixture = await createPluginFlowFixture(databaseUrl);
const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin });
const output = resolve(process.argv[2] ?? "findings/plugin-flow-parity-2026-09-16");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1050, height: 900 } });
const errors: string[] = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
let networkFault: { pathname: string; afterCommit?: boolean } | null = {
  pathname: "/api/v0/plugins",
};
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
  if (networkFault?.pathname === url.pathname) {
    const fault = networkFault;
    networkFault = null;
    if (fault.afterCommit) {
      await route.fetch();
      return route.abort("connectionreset");
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        error: { code: "fixture_outage", message: "Synthetic server unavailable" },
      }),
    });
  }
  return route.continue();
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const eventually = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("Fixture state did not settle");
};
const page = await context.newPage();
const openProvider = async (click: () => Promise<unknown>) => {
  const pending = context.waitForEvent("page", { timeout: 15000 });
  await click();
  const provider = await pending;
  await provider.getByRole("heading", { name: "Authorize test provider" }).waitFor();
  return provider;
};
try {
  await page.goto(
    `http://127.0.0.1:63387/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(fixture.server.url.origin)}`
  );
  await page.getByRole("alert").filter({ hasText: "Synthetic server unavailable" }).waitFor();
  await page.getByRole("button", { name: "Reload plugins", exact: true }).click();
  await page.getByRole("button", { name: "Open Flow OAuth", exact: true }).click();
  let provider = await openProvider(() =>
    page.getByRole("button", { name: "Add", exact: true }).click()
  );
  await page.getByText("Waiting for authorization", { exact: true }).waitFor();
  const originalUrl = await page.getByRole("link", { name: "Reopen sign-in" }).getAttribute("href");
  const initial = (await client.pluginSettings()).installs.find(
    (row) => row.pluginKey === fixture.definitions[0]!.key
  )!.connections[0]!;
  await provider.close();
  await page.getByRole("button", { name: "Close plugins" }).click();
  await page.getByRole("button", { name: "Open plugins", exact: true }).click();
  await page.getByRole("button", { name: "Open Flow OAuth", exact: true }).click();
  assert(
    (await page.getByRole("link", { name: "Reopen sign-in" }).getAttribute("href")) === originalUrl,
    "Closing settings replaced the pending authorization"
  );
  provider = await openProvider(() => page.getByRole("link", { name: "Reopen sign-in" }).click());
  await page.screenshot({ path: resolve(output, "ours-waiting.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await page
    .getByText("Authorization was cancelled. You can try again when ready.", { exact: true })
    .first()
    .waitFor();
  await provider.getByRole("button", { name: "Authorize Account A" }).click();
  await provider.getByRole("heading", { name: "This sign-in is no longer active" }).waitFor();
  const cancelled = await fixture.db.pluginConnection.findUniqueOrThrow({
    where: { id: initial.id },
  });
  assert(
    !(cancelled.credentials as any).oauth?.tokens,
    "Late callback revived cancelled authorization"
  );
  await provider.close();
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Retry", exact: true }).click()
  );
  await provider.getByRole("button", { name: "Cancel", exact: true }).click();
  await provider.getByRole("heading", { name: "Authorization cancelled" }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await provider.close();
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Retry", exact: true }).click()
  );
  const expiringUrl = provider.url();
  await provider.close();
  const expiring = await fixture.db.pluginConnection.findUniqueOrThrow({
    where: { id: initial.id },
  });
  const expiredCredentials = expiring.credentials as { oauth: { stateCreatedAt: number } };
  expiredCredentials.oauth.stateCreatedAt = Date.now() - 16 * 60_000;
  await fixture.db.pluginConnection.update({
    where: { id: initial.id },
    data: { credentials: expiredCredentials },
  });
  await page.getByText("Sign-in expired", { exact: true }).waitFor();
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Try again", exact: true }).click()
  );
  assert(provider.url() !== expiringUrl, "Retry reused an expired authorization");
  await provider.getByRole("button", { name: "Authorize Account A" }).click();
  await page.getByText("Connected", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Another Account" }).click();
  await page.getByLabel("New account label", { exact: true }).fill("personal");
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Add Account", exact: true }).click()
  );
  await provider.getByRole("button", { name: "Authorize Account B" }).click();
  await eventually(async () => (await page.getByText("Connected", { exact: true }).count()) === 2);
  const accounts = (await client.pluginSettings()).installs.find(
    (row) => row.pluginKey === fixture.definitions[0]!.key
  )!.connections;
  for (const account of accounts) {
    const result = await client.testPluginConnection(account.id, {
      toolName: "whoami",
      arguments: {},
    });
    assert(
      JSON.stringify(result).includes(account.alias === "personal" ? "Account B" : "Account A"),
      "Account tokens crossed between labels"
    );
  }
  await page.getByRole("button", { name: "Add Another Account" }).click();
  await page.getByLabel("New account label", { exact: true }).fill("personal");
  await page.getByRole("button", { name: "Add Account", exact: true }).click();
  await page.getByText("That account alias already exists", { exact: true }).waitFor();
  assert(
    (await page.getByLabel("New account label", { exact: true }).inputValue()) === "personal",
    "Failed add discarded the label"
  );
  await page.getByLabel("New account label", { exact: true }).press("Escape");
  assert(
    await page.getByRole("button", { name: "Add Another Account" }).isVisible(),
    "Escape closed the plugin dialog"
  );
  await page.getByRole("button", { name: "Edit personal account", exact: true }).click();
  await page.getByLabel("Rename personal account", { exact: true }).fill("default");
  await page.getByRole("button", { name: "Save personal account", exact: true }).click();
  await page.getByText("That account alias already exists", { exact: true }).waitFor();
  assert(
    (await page.getByLabel("Rename personal account", { exact: true }).inputValue()) === "default",
    "Failed rename discarded the edit"
  );
  await page.getByLabel("Rename personal account", { exact: true }).fill("discarded edit");
  await page.getByLabel("Rename personal account", { exact: true }).press("Escape");
  assert(
    (await client.pluginSettings()).installs
      .flatMap((row) => row.connections)
      .some((row) => row.alias === "personal"),
    "Escape saved account edits"
  );
  await page.screenshot({ path: resolve(output, "ours-connected-accounts.png"), fullPage: true });
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert(
    (await client.pluginSettings()).installs.some(
      (row) => row.pluginKey === fixture.definitions[0]!.key
    ),
    "Cancelling uninstall removed the plugin"
  );
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await page.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).waitFor();
  assert(
    !(await client.pluginSettings()).installs.some(
      (row) => row.pluginKey === fixture.definitions[0]!.key
    ),
    "Uninstall did not remove the plugin"
  );
  await page.getByRole("button", { name: "Back to Marketplace" }).click();
  await page.getByRole("button", { name: "Open Flow Manual Setup", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Set up later" }).click();
  assert(
    (await page.getByLabel("Client ID", { exact: true }).count()) === 0,
    "Set up later retained private form fields"
  );
  await page.getByRole("button", { name: "Set up", exact: true }).click();
  const manual = (await client.pluginSettings()).installs.find(
    (row) => row.pluginKey === fixture.definitions[1]!.key
  )!.connections[0]!;
  fixture.provider.registerClient(
    "flow-manual-client",
    manual.oauthRedirectUrl!,
    "flow-manual-secret"
  );
  await page.getByLabel("Client ID", { exact: true }).fill("flow-manual-client");
  await page.getByLabel("Client secret", { exact: true }).fill("flow-manual-secret");
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Save credentials and continue" }).click()
  );
  await provider.close();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await page.getByText("Credentials saved", { exact: true }).waitFor();
  assert(
    (await page.locator('input[type="password"]').count()) === 0,
    "Saved setup secret remained in form"
  );
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Authorize account", exact: true }).click()
  );
  fixture.provider.registerClient(
    "flow-manual-client",
    manual.oauthRedirectUrl!,
    "rejected-fixture-secret"
  );
  await provider.getByRole("button", { name: "Authorize Account A" }).click();
  await provider.getByRole("heading", { name: "Could not finish sign-in" }).waitFor();
  await page
    .getByText(/Authorization failed:/)
    .first()
    .waitFor();
  assert(
    (await page.getByText("Waiting for authorization", { exact: true }).count()) === 0,
    "Failed exchange still showed a pending sign-in"
  );
  assert(
    (await page.getByText("Connected", { exact: true }).count()) === 0,
    "Failed exchange appeared connected"
  );
  await provider.close();
  fixture.provider.registerClient(
    "flow-manual-client",
    manual.oauthRedirectUrl!,
    "flow-manual-secret"
  );
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Authorize account", exact: true }).click()
  );
  await provider.getByRole("button", { name: "Authorize Account A" }).click();
  await page.getByText("Connected", { exact: true }).waitFor();
  await page.goto(
    `http://127.0.0.1:63387/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(fixture.server.url.origin)}&reviewPlugin=${encodeURIComponent(fixture.definitions[1]!.key)}`
  );
  await page.getByRole("button", { name: "Open plugin setup", exact: true }).click();
  await page.getByText("Connected", { exact: true }).waitFor();
  fixture.provider.setUnavailable(true);
  const authExchangesBeforeOutage = fixture.provider.observations.authMethods.length;
  await page.getByRole("button", { name: "default account settings", exact: true }).click();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.getByText("Connection error", { exact: true }).waitFor();
  assert(
    (await page.getByText("Connected", { exact: true }).count()) === 0,
    "Unavailable provider still appeared connected"
  );
  await page.screenshot({ path: resolve(output, "provider-unavailable.png"), fullPage: true });
  fixture.provider.setUnavailable(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Connected", { exact: true }).waitFor();
  assert(
    fixture.provider.observations.authMethods.length === authExchangesBeforeOutage,
    "Retrying a provider outage repeated authorization"
  );
  // Install rejected before commit: remain installable. Lost reply after commit:
  // refresh authoritative state and never repeat installation automatically.
  await page.getByRole("button", { name: "Back to Marketplace", exact: true }).click();
  await page.getByRole("button", { name: "Open Flow Skills", exact: true }).click();
  networkFault = { pathname: "/api/v0/plugins/install" };
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Synthetic server unavailable" }).waitFor();
  assert(
    !(await client.pluginSettings()).installs.some(
      (row) => row.pluginKey === fixture.definitions[2]!.key
    ),
    "Failed installation falsely persisted"
  );
  networkFault = { pathname: "/api/v0/plugins/install", afterCommit: true };
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Uninstall", exact: true }).waitFor();
  assert(
    (await client.pluginSettings()).installs.filter(
      (row) => row.pluginKey === fixture.definitions[2]!.key
    ).length === 1,
    "Lost install response duplicated the plugin"
  );
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  networkFault = { pathname: `/api/v0/plugins/${encodeURIComponent(fixture.definitions[2]!.key)}` };
  await page.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Synthetic server unavailable" }).waitFor();
  assert(
    (await client.pluginSettings()).installs.some(
      (row) => row.pluginKey === fixture.definitions[2]!.key
    ),
    "Failed uninstall removed the plugin"
  );
  await page.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).waitFor();
  assert(errors.length === 0, errors.join("\n"));
  console.log(
    "PASS: rendered install→OAuth, close/reopen, cancel and late callback rejection, provider denial, expiry/retry/success, separate accounts, failed add/rename preservation, Escape, uninstall cancel/confirm, self-hosted setup/skip/resume, secret-field clearing, failed token-exchange recovery; provider outage/retry without OAuth; initial load retry; install rejection; lost install reply; failed uninstall retry."
  );
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await fixture.close();
}
