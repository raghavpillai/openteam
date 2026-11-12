/** Real plugin settings UI, backend/database and OAuth transport; synthetic T3-shaped provider. */
import { chromium } from "../../computer/node_modules/playwright-core";
import { createOpenTeamClient } from "../../../packages/client-core/src";
import { pluginCatalog } from "../../../packages/plugins/src";
import { createPluginFlowFixture } from "../../server/test/plugin/fixtures/plugin-flow";

if (!process.env.OPENTEAM_TEST_DATABASE_URL) throw new Error("A disposable database is required");
const fixture = await createPluginFlowFixture(process.env.OPENTEAM_TEST_DATABASE_URL, {
  refreshTokens: false,
  authSessions: ["t3-ui-owner"],
});
const definition = structuredClone(pluginCatalog.find((p) => p.key === "t3-code")!);
definition.key = `t3-ui-${crypto.randomUUID()}`;
fixture.definitions.push(definition);
const client = createOpenTeamClient({
  baseUrl: fixture.server.url.origin,
  getAuthToken: () => "t3-ui-owner",
});
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext();
context.setDefaultTimeout(15_000);
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
try {
  await context.route("http://127.0.0.1:42813/**", (route) => route.abort("connectionrefused"));
  await page.goto(
    `http://127.0.0.1:63387/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(fixture.server.url.origin)}&authSession=t3-ui-owner&reviewPlugin=${encodeURIComponent(definition.key)}`
  );
  await page.getByRole("button", { name: "Open plugin setup", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const urlInput = page.getByLabel("T3 Code MCP URL", { exact: true });
  await urlInput.waitFor();
  assert(
    !fixture.requests.some((r) => r.method === "POST" && r.path.endsWith("/authenticate")),
    "Installation must collect the URL before starting OAuth"
  );
  const connection = (await client.pluginSettings()).installs.find(
    (p) => p.pluginKey === definition.key
  )!.connections[0]!;
  await urlInput.fill("http://192.168.1.5:3773/mcp");
  const first = fixture.requests.length;
  await page.getByRole("button", { name: "Validate URL and connect", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "HTTPS" }).waitFor();
  assert(
    !fixture.requests
      .slice(first)
      .some((r) => r.method === "POST" && r.path.endsWith("/authenticate")),
    "Invalid URLs must fail before OAuth"
  );
  await urlInput.fill(fixture.provider.endpoint);
  const start = fixture.requests.length;
  await page.getByRole("button", { name: "Validate URL and connect", exact: true }).click();
  await page.getByText("Before you sign in", { exact: true }).waitFor();
  const requests = fixture.requests.slice(start);
  const save = requests.findIndex((r) => r.method === "PUT" && r.path.endsWith("/configuration"));
  const auth = requests.findIndex((r) => r.method === "POST" && r.path.endsWith("/authenticate"));
  assert(save >= 0 && auth > save, "Save the per-account URL before OAuth discovery");
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Continue to browser", exact: true }).click();
  const provider = await popup;
  await provider.getByRole("button", { name: "Authorize Account A", exact: true }).waitFor();
  const callback = context.waitForEvent("request", (r) => new URL(r.url()).port === "42813");
  await provider.getByRole("button", { name: "Authorize Account A", exact: true }).click();
  const returned = (await callback).url();
  await page.getByLabel("Browser address from sign-in", { exact: true }).fill(returned);
  await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
  await page.getByText("Connected", { exact: true }).first().waitFor();
  assert(
    JSON.stringify(
      await client.testPluginConnection(connection.id, { toolName: "whoami", arguments: {} })
    ).includes("Account A"),
    "Connected account executes an authenticated tool"
  );
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log(
    "PASS: URL validation, save-before-OAuth, browser approval, manual callback, authenticated discovery and tool call."
  );
} finally {
  await browser.close();
  await fixture.close();
}
