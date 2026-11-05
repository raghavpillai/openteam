/** Disposable database and the real plugin dialog: setup-card fields must be saved before Connect. */
import { createPluginTemplate } from "@openteam/plugin-sdk";
import { chromium } from "../../computer/node_modules/playwright-core";
import { createPluginFlowFixture } from "../../server/test/plugin/fixtures/plugin-flow";

if (!process.env.OPENTEAM_TEST_DATABASE_URL) throw new Error("A disposable test database is required");
const uiOrigin = process.env.OPENTEAM_TEST_UI_ORIGIN ?? "http://127.0.0.1:63387";
const fixture = await createPluginFlowFixture(process.env.OPENTEAM_TEST_DATABASE_URL, { packaged: true });
// A packaged connector whose only setup is a non-secret value, like a Mac's SSH address.
const plugin = createPluginTemplate("packaged-mcp", `flow-address-${crypto.randomUUID()}`);
plugin.name = "Flow Address";
plugin.setupFields = [];
const connector = plugin.connections[0]!;
connector.configuration = { ...connector.configuration, env: { FLOW_ADDRESS: "${ADDRESS}" } };
plugin.setup = {
  kind: "none",
  connectionKey: connector.key,
  title: "Connect your account",
  description: "Enter the account address once.",
  documentationUrl: null,
  requiredScopes: [],
  steps: ["Enter the address, then choose Connect."],
  fields: [{ key: "ADDRESS", label: "Account address", required: true, secret: false }],
};
fixture.definitions.push(plugin);
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
try {
  const context = await browser.newContext({ viewport: { width: 1050, height: 900 } });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${uiOrigin}/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(fixture.server.url.origin)}&reviewPlugin=${encodeURIComponent(plugin.key)}`);
  await page.getByRole("button", { name: "Open plugin setup", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // The dialog ignores actions while installation is still settling.
  await page.locator("button:enabled", { hasText: /^Uninstall$/ }).waitFor();
  await page.getByLabel("Account address", { exact: true }).fill("  user@100.64.0.10 ");
  const firstRequest = fixture.requests.length;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Connected", { exact: true }).or(page.getByRole("alert")).first().waitFor();
  const actions = fixture.requests.slice(firstRequest).filter(request => request.method !== "GET").map(request => `${request.method} ${request.path}`);
  assert(/^PUT .*\/configuration$/.test(actions[0] ?? "") && /^POST .*\/connect$/.test(actions[1] ?? ""), "Connect must save setup values first: " + actions.join(", "));
  const account = await fixture.db.pluginConnection.findFirstOrThrow({ where: { installation: { pluginKey: plugin.key } } });
  assert((account.configuration as { values?: Record<string, unknown> }).values?.ADDRESS === "user@100.64.0.10", "The entered address was not saved");
  assert(account.status === "ready", "The account did not connect: " + account.statusMessage);
  assert(errors.length === 0, errors.join("\n"));
  console.log("PASS: setup-card values are saved before connecting a non-OAuth packaged connector.");
} finally {
  await browser.close();
  await fixture.close();
}
