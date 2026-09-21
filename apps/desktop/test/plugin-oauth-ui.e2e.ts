/** Browser UI + production desktop listener + real routes/DB; only synthetic provider accounts. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core";
import { createPluginFlowFixture } from "../../server/test/plugin/fixtures/plugin-flow";
import { createOpenTeamClient } from "../../../packages/client-core/src";
import { DesktopPluginOAuth } from "../src/main/plugin-oauth";

if (!process.env.OPENTEAM_TEST_DATABASE_URL)
  throw new Error("A disposable test database is required");
const fixture = await createPluginFlowFixture(process.env.OPENTEAM_TEST_DATABASE_URL, { callbackMode: "desktop" });
const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin });
const output = resolve("findings/oauth-desktop-implementation-2026-09-20/native-ui");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1050, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const native = new DesktopPluginOAuth((result) => {
  void page
    .evaluate(
      (result) => window.dispatchEvent(new CustomEvent("fixture-oauth-result", { detail: result })),
      result
    )
    .catch(() => {});
});
await page.exposeFunction("fixtureOAuthStart", (id: string, force: boolean) =>
  native.start("fixture-session", id, client, force)
);
await page.exposeFunction("fixtureOAuthCancel", (id: string, state: string) =>
  native.cancel(id, state)
);
await page.exposeFunction("fixtureOAuthClose", () => native.closeAll());
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  // Never let the synthetic UI reach the Vite proxy for the real deployment.
  if (url.hostname !== "127.0.0.1" || (url.port === "63387" && url.pathname.startsWith("/api/")))
    return route.abort();
  return route.continue();
});
await page.addInitScript(() => {
  const target = window as any;
  target.openteam = {
    pluginOAuth: {
      start: (id: string, force = false) => target.fixtureOAuthStart(id, force),
      cancel: (id: string, state: string) => target.fixtureOAuthCancel(id, state),
      close: () => target.fixtureOAuthClose(),
      onResult: (callback: (value: unknown) => void) => {
        const listener = (event: Event) => callback((event as CustomEvent).detail);
        window.addEventListener("fixture-oauth-result", listener);
        return () => window.removeEventListener("fixture-oauth-result", listener);
      },
    },
  };
});
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const openProvider = async (action: () => Promise<unknown>) => {
  const pending = context.waitForEvent("page", { timeout: 10_000 });
  await action();
  const provider = await pending;
  await provider.getByRole("heading", { name: "Authorize test provider" }).waitFor();
  return provider;
};
try {
  await page.goto(
    `http://127.0.0.1:63387/test/browser/plugin-lifecycle.html?nativeOAuth=fixture&server=${encodeURIComponent(fixture.server.url.origin)}`
  );
  await page.getByRole("button", { name: "Open Flow OAuth", exact: true }).click();
  let provider = await openProvider(() =>
    page.getByRole("button", { name: "Add", exact: true }).click()
  );
  const original = provider.url();
  const callback = new URL(original).searchParams.get("redirect_uri")!;
  assert(
    new URL(callback).origin !== fixture.server.url.origin,
    "Callback must be on the desktop listener"
  );
  await provider.close();
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Reopen sign-in", exact: true }).click()
  );
  assert(provider.url() === original, "Reopening must reuse a live listener and state");
  await page.screenshot({ path: resolve(output, "waiting.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await page
    .getByText("Ready to authorize", { exact: true })
    .first()
    .waitFor();
  await provider.close();
  provider = await openProvider(() =>
    page.getByRole("button", { name: "Authorize", exact: true }).click()
  );
  await provider.getByRole("button", { name: "Authorize Account A" }).click();
  await provider
    .getByText("Authorization received. Return to OpenTeam to see the result.")
    .waitFor();
  await page.getByText("Connected", { exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(output, "connected.png"), fullPage: true });
  const settings = await client.pluginSettings();
  const connection = settings.installs.find((row) => row.pluginKey === fixture.definitions[0]!.key)!
    .connections[0]!;
  assert(connection.status === "ready", "Backend must persist ready status");
  assert(
    JSON.stringify(
      await client.testPluginConnection(connection.id, { toolName: "whoami", arguments: {} })
    ).includes("Account A"),
    "Connected account must execute a real fixture tool"
  );
  await page.getByRole("button", { name: "default account settings", exact: true }).click();
  await page.getByLabel("Sign-in callback", { exact: true }).selectOption("server");
  await page.getByRole("button", { name: "Save callback settings", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('select[aria-label="Sign-in callback"]') as HTMLSelectElement)?.value === "server");
  await page.getByRole("button", { name: "Save callback settings", exact: true }).waitFor();
  assert((await client.pluginConfiguration(connection.id)).oauthCallbackMode === "server", "Callback mode must persist in DB");
  await page.getByLabel("Sign-in callback", { exact: true }).selectOption("desktop");
  await page.getByRole("button", { name: "Save callback settings", exact: true }).click();
  await page.screenshot({ path: resolve(output, "callback-settings.png"), fullPage: true });
  provider = await openProvider(() => page.getByRole("button", { name: "Authenticate", exact: true }).click());
  const closingCallback = new URL(provider.url()).searchParams.get("redirect_uri")!;
  await page.getByRole("button", { name: "Close plugins", exact: true }).click();
  const deadline = Date.now() + 5000;
  while ((await client.pluginConnectionStatuses([connection.id])).connections[0]?.authorizationUrl && Date.now() < deadline) await Bun.sleep(20);
  assert(!(await client.pluginConnectionStatuses([connection.id])).connections[0]?.authorizationUrl, "Closing settings must cancel pending authentication");
  let closed = false;
  try { await fetch(closingCallback); } catch { closed = true; }
  assert(closed, "Closing settings must close the desktop listener");
  assert(errors.length === 0, "Unexpected UI errors: " + errors.join(", "));
  await Bun.write(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "desktop callback",
          "reopen",
          "cancel",
          "retry",
          "browser authorization",
          "connected UI",
          "backend tool call",
          "callback mode configuration",
          "dialog close cancels authentication",
        ],
        errors,
      },
      null,
      2
    )
  );
  console.log("Desktop OAuth UI end-to-end passed");
} finally {
  native.closeAll();
  await browser.close();
  await fixture.close();
}
