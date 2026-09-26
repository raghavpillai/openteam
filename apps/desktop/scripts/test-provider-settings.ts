/** Drive the real Providers settings UI in Chrome against a real OpenTeam server, database and
 * computer (connection checks run real requests).
 * Usage: PROVIDERS_QA_BASE_URL=http://127.0.0.1:8787 [PROVIDERS_QA_TOKEN=…] [EXA_API_KEY=…] bun scripts/test-provider-settings.ts
 * With EXA_API_KEY the Exa checks must pass; without it they must fail cleanly.
 * Leaves the server with search off, built-in fetch and no saved provider fields. */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "../../computer/node_modules/playwright-core";
import { createServer } from "vite";
import { createOpenTeamClient } from "@openteam/client-core";
import { WEB_PROVIDER_LISTS, type WebProvidersInput } from "@openteam/contracts/web-search";

const repo = resolve(import.meta.dir, "../../..");
const baseUrl = process.env.PROVIDERS_QA_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.PROVIDERS_QA_TOKEN;
const exaKey = process.env.EXA_API_KEY;
const output = resolve(repo, process.env.PROVIDERS_QA_OUTPUT ?? "output/provider-settings-ui");
await mkdir(output, { recursive: true });
const client = createOpenTeamClient({ baseUrl, getAuthToken: () => token });
const syntheticKey = "qa-synthetic-brave-key-never-shown";
const checks: string[] = [];
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(`FAILED: ${message}`);
  checks.push(message);
};

const reset = async () => {
  const clear = (tool: "search" | "fetch") =>
    Object.fromEntries(WEB_PROVIDER_LISTS[tool].filter((p) => p.fields.length).map((p) => [p.id, { apiKey: null }]));
  const input: WebProvidersInput = {
    search: { selected: null, providers: clear("search") },
    fetch: { selected: "builtin", providers: clear("fetch") },
  };
  await client.updateWebProviders(input);
};

type Tool = "search" | "fetch";
async function save(page: Page, expectError?: string) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  if (expectError) await page.getByRole("alert").filter({ hasText: expectError }).waitFor();
  else await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
}
const row = (page: Page, tool: Tool, id: string) => page.getByTestId(`provider-${tool}:${id}`);
const text = async (page: Page, testId: string) => (await page.getByTestId(testId).textContent())?.trim();
/** Opens a tool's page from the overview, or returns to the overview. */
async function openTool(page: Page, tool: Tool) {
  await page.getByTestId(`providers-${tool}`).click();
  await page.getByLabel(`Turn ${tool} off`).and(page.locator(":enabled")).waitFor();
}
async function back(page: Page) {
  await page.getByRole("button", { name: "Back to Providers" }).click();
  await page.getByTestId("search-provider").waitFor();
}
/** Clicks Check, then waits for the server to store a new result and the UI to settle. */
async function check(page: Page, tool: Tool, id: string, name: string) {
  const before = (await client.webProviders())[tool].providers[id]!.check?.checkedAt;
  await page.getByRole("button", { name: `Check ${name} ${tool}` }).click();
  for (let i = 0; i < 90 && (await client.webProviders())[tool].providers[id]!.check?.checkedAt === before; i++) await Bun.sleep(1_000);
  await page.getByRole("button", { name: `Check ${name} ${tool}` }).and(page.locator(":enabled")).waitFor({ timeout: 30_000 });
}

await reset();
const buildDir = await mkdtemp(join(tmpdir(), "openteam-provider-ui-"));
const vite = await createServer({
  root: join(repo, "apps/desktop"),
  cacheDir: join(buildDir, "desktop-cache"),
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 620 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((fixture) => ((window as any).providersFixture = fixture), { baseUrl, token });
  const open = async () => {
    await page.goto(`${vite.resolvedUrls!.local[0]}test/browser/providers-settings.html`);
    await page.getByTestId("search-provider").waitFor();
  };
  await open();

  // Fresh install: the overview shows search off and built-in fetch, and both warn.
  assert((await text(page, "search-provider")) === "Off", "overview: search is off");
  assert((await text(page, "search-note")) === "Bots can't search the web.", "overview: search off warns");
  assert((await text(page, "fetch-provider")) === "Built-in", "overview: fetch is built-in");
  assert((await text(page, "fetch-note")) === "Basic pages only; can't run JavaScript.", "overview: built-in fetch warns");
  assert((await page.getByTestId("fetch-provider").locator("img").count()) === 1, "overview: active provider shows its logo");
  await page.screenshot({ path: join(output, "01-overview-defaults.png"), fullPage: true });

  // Search page: Off plus every search provider, each with its logo.
  await openTool(page, "search");
  assert((await page.getByRole("heading", { level: 2 }).textContent())?.replace(/\s+/g, "") === "ProvidersSearch", "search page has a breadcrumb");
  assert(await page.getByLabel("Turn search off").isChecked(), "search Off is selected");
  const region = page.getByRole("region", { name: "Search providers" });
  for (const provider of WEB_PROVIDER_LISTS.search)
    assert(await region.getByText(provider.name, { exact: true }).isVisible(), `search lists ${provider.name}`);
  const icons = await region.locator("img").evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length);
  assert(icons === WEB_PROVIDER_LISTS.search.length, `search provider logos render (${icons})`);
  const [offBox, exaBox] = await Promise.all([
    page.getByText("Off", { exact: true }).boundingBox(),
    region.getByText("Exa", { exact: true }).boundingBox(),
  ]);
  assert(offBox && exaBox && Math.abs(offBox.x - exaBox.x) < 1, "Off lines up with the provider names");
  await page.screenshot({ path: join(output, "02-search-page.png"), fullPage: true });

  // Selecting a provider without its key warns, and the server rejects the save.
  await page.getByLabel("Use Exa for search").check();
  assert(await row(page, "search", "exa").getByText("Add the API key to use Exa for search.").isVisible(), "missing key warning");
  await save(page, "Add the Exa API key to use it for search.");
  assert((await client.webProviders()).search.selected === null, "rejected save changed nothing");

  // Search Exa: save the key, then run a real check.
  await page.getByLabel("Exa search API key").fill(exaKey ?? "qa-invalid-exa-key");
  await save(page);
  let view = await client.webProviders();
  assert(view.search.selected === "exa" && view.search.providers.exa!.secretSaved, "search Exa saved");
  assert(!view.fetch.providers.exa!.secretSaved, "fetch Exa keeps its own, separate key");
  await check(page, "search", "exa", "Exa");
  view = await client.webProviders();
  assert(view.search.providers.exa!.check?.status === (exaKey ? "passed" : "failed"), `search Exa check ${view.search.providers.exa!.check?.message}`);
  await page.screenshot({ path: join(output, "03-search-exa-checked.png"), fullPage: true });

  // A bad key fails its check and says why; the result is stored.
  await row(page, "search", "brave").getByRole("button", { name: /^Brave Search/ }).click();
  await page.getByLabel("Brave Search search API key").fill(syntheticKey);
  await save(page);
  await check(page, "search", "brave", "Brave Search");
  view = await client.webProviders();
  assert(view.search.providers.brave!.check?.status === "failed", "bad Brave key fails its check");
  assert(await row(page, "search", "brave").getByText("Check failed", { exact: true }).isVisible(), "failed check shown");
  assert(
    await row(page, "search", "brave").getByText(view.search.providers.brave!.check!.message.slice(0, 40), { exact: false }).first().isVisible(),
    "failure message shown"
  );

  // Unsaved changes are discarded when leaving the page.
  await page.getByLabel("Use Brave Search for search").check();
  await back(page);
  assert((await client.webProviders()).search.selected === "exa", "leaving the page saved nothing");
  assert((await text(page, "search-provider")) === "Exa", "overview shows the selected search provider");
  if (exaKey) assert((await text(page, "search-note")) === "How bots find information on the web.", "a checked provider has no warning");
  await page.screenshot({ path: join(output, "04-overview-exa.png"), fullPage: true });

  // Fetch page: the built-in check reads a real page through the computer.
  await openTool(page, "fetch");
  await check(page, "fetch", "builtin", "Built-in");
  view = await client.webProviders();
  assert(view.fetch.providers.builtin!.check?.status === "passed", `built-in check ${view.fetch.providers.builtin!.check?.message}`);

  // Fetch Exa uses its own key.
  await page.getByLabel("Use Exa for fetch").check();
  await page.getByLabel("Exa fetch API key").fill(exaKey ?? "qa-invalid-exa-key");
  await save(page);
  await check(page, "fetch", "exa", "Exa");
  view = await client.webProviders();
  assert(view.fetch.selected === "exa" && view.fetch.providers.exa!.check?.status === (exaKey ? "passed" : "failed"), "fetch Exa checked");
  await page.screenshot({ path: join(output, "05-fetch-exa-checked.png"), fullPage: true });

  // A key in use cannot be removed until the tool moves elsewhere.
  await back(page);
  await openTool(page, "search");
  await row(page, "search", "exa").getByRole("button", { name: /^Exa/ }).click();
  await row(page, "search", "exa").getByRole("button", { name: "Remove" }).click();
  await save(page, "Exa is used for search. Choose another search provider before removing its API key.");
  await page.getByLabel("Turn search off").check();
  await save(page);
  view = await client.webProviders();
  assert(view.search.selected === null && !view.search.providers.exa!.secretSaved, "turned search off and removed the search key");
  assert(view.fetch.providers.exa!.secretSaved, "fetch Exa key unaffected");

  // Fetch off warns and survives a reload.
  await back(page);
  await openTool(page, "fetch");
  await page.getByLabel("Turn fetch off").check();
  assert((await text(page, "fetch-warning")) === "Bots can only read pages in their browser.", "fetch off warns before saving");
  await save(page);
  assert((await client.webProviders()).fetch.selected === null, "fetch off persisted");
  await open();
  assert((await text(page, "fetch-provider")) === "Off", "overview: fetch off after reload");
  assert((await text(page, "fetch-note")) === "Bots can only read pages in their browser.", "overview: fetch off warns");
  await page.screenshot({ path: join(output, "06-overview-off.png"), fullPage: true });
  const dom = await page.content();
  assert(!dom.includes(syntheticKey) && !(exaKey && dom.includes(exaKey)), "keys never rendered in the DOM");
  assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(syntheticKey), "keys not stored in the browser");

  // The overview is reachable from the Settings dialog navigation (stubbed API harness).
  const panel = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
  panel.on("pageerror", (error) => errors.push(error.message));
  await panel.goto(`${vite.resolvedUrls!.local[0]}test/browser/settings-loading.html`);
  await panel.getByRole("button", { name: "Providers", exact: true }).click();
  await panel.getByRole("heading", { name: "Providers", exact: true }).waitFor();
  assert((await panel.getByTestId("search-provider").textContent()) === "Off", "Providers opens from Settings navigation");
  await panel.screenshot({ path: join(output, "07-settings-dialog.png") });
  await panel.getByTestId("providers-search").click();
  await panel.getByLabel("Turn search off").waitFor();
  await panel.screenshot({ path: join(output, "08-settings-dialog-search.png") });
  assert(errors.length === 0, `no page errors (${errors.join("; ")})`);
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }, null, 2));
} finally {
  await reset().catch(() => {});
  await browser.close();
  await vite.close();
}
