/** Real plugin UI, API, database and a local synthetic OAuth provider. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core";
import { createPluginFlowFixture } from "../../server/test/plugin/fixtures/plugin-flow";
import { createOpenTeamClient } from "../../../packages/client-core/src";

if (!process.env.OPENTEAM_TEST_DATABASE_URL)
  throw new Error("A disposable test database is required");
const fixture = await createPluginFlowFixture(process.env.OPENTEAM_TEST_DATABASE_URL, {
  callbackMode: "auto",
});
const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin });
const output = resolve("findings/oauth-unified-20260921");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1050, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let callback = "";
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.hostname !== "127.0.0.1" || (url.port === "63387" && url.pathname.startsWith("/api/")))
    return route.abort();
  if (url.port === "42813" && url.pathname === "/callback") {
    callback = url.href;
    return route.abort("connectionrefused");
  }
  return route.continue();
});
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
try {
  await page.goto(
    `http://127.0.0.1:63387/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(fixture.server.url.origin)}`
  );
  await page.getByRole("button", { name: "Open Flow OAuth", exact: true }).click();
  await page.getByText("Installation steps", { exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("Before you sign in", { exact: true }).waitFor();
  assert(context.pages().length === 1, "HTTP sign-in must not open the provider before the instructions");
  await page.getByText(/The browser may say it can’t open the page/).waitFor();
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Continue to browser", exact: true }).click();
  const provider = await opened;
  const returned = context.waitForEvent(
    "request",
    (request) => new URL(request.url()).port === "42813"
  );
  await provider.getByRole("button", { name: "Authorize Account A", exact: true }).click();
  callback = (await returned).url();
  assert(
    callback.includes("state=") && callback.includes("code="),
    "Provider must return a complete loopback response"
  );
  const input = page.getByLabel("Browser address from sign-in", { exact: true });
  await input.waitFor();
  assert(
    (await input.getAttribute("type")) === "password",
    "Callback must use a masked dedicated field"
  );
  await page.screenshot({ path: resolve(output, "manual-waiting.png"), fullPage: true });
  await input.fill(callback);
  await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
  await page.getByText("Connected", { exact: true }).first().waitFor();
  assert(
    (await page.getByLabel("Browser address from sign-in").count()) === 0,
    "Callback input must disappear after completion"
  );
  const settings = await client.pluginSettings();
  const connection = settings.installs.find((row) => row.pluginKey === fixture.definitions[0]!.key)!
    .connections[0]!;
  assert(
    connection.setupPhase === "connected",
    "Backend must validate tool discovery before Connected"
  );
  assert(
    JSON.stringify(
      await client.testPluginConnection(connection.id, { toolName: "whoami", arguments: {} })
    ).includes("Account A"),
    "Connected account must execute a fixture tool"
  );
  await page.getByRole("button", { name: "default account settings", exact: true }).click();
  assert(
    (await page.getByLabel("Sign-in callback", { exact: true }).inputValue()) === "auto",
    "Polling must preserve Automatic rather than persisting the resolved mode"
  );
  await page.screenshot({ path: resolve(output, "manual-connected.png"), fullPage: true });
  const automatic = await createPluginFlowFixture(process.env.OPENTEAM_TEST_DATABASE_URL, {
    callbackMode: "auto",
    publicUrl: "https://openteam.fixture.test",
  });
  try {
    await page.goto(
      `http://127.0.0.1:63387/test/browser/plugin-lifecycle.html?server=${encodeURIComponent(automatic.server.url.origin)}`
    );
    await page.getByRole("button", { name: "Open Flow OAuth", exact: true }).click();
    const automaticallyOpened = context.waitForEvent("page", { timeout: 10_000 });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const automaticProvider = await automaticallyOpened;
    await automaticProvider.getByRole("heading", { name: "Authorize test provider" }).waitFor();
    assert(
      new URL(automaticProvider.url()).searchParams.get("redirect_uri")?.startsWith("https://openteam.fixture.test/"),
      "Automatic HTTPS must retain its server callback"
    );
    assert(
      await page.getByText("Before you sign in", { exact: true }).count() === 0,
      "HTTPS must open the provider without the HTTP instructions"
    );
    await automaticProvider.close();
  } finally {
    await automatic.close();
  }
  assert(errors.length === 0, "Unexpected UI errors: " + errors.join(", "));
  await Bun.write(
    resolve(output, "manual-ui-result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "registry instructions",
          "HTTP instructions before browser handoff",
          "HTTPS opens immediately with its server callback",
          "local-browser sign-in",
          "failed loopback page",
          "masked callback form",
          "backend completion and discovery",
          "connected UI",
          "tool execution",
          "automatic mode preserved",
        ],
        errors,
      },
      null,
      2
    )
  );
  console.log("Manual OAuth UI end-to-end passed");
} finally {
  await browser.close();
  await fixture.close();
}
