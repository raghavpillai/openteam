/** Exercise the real Settings navigation and server-backed model form. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core";
import { ServerSetupFixture } from "../../ios/scripts/server-setup-fixture";

const repo = resolve(import.meta.dir, "../../..");
const output = join(repo, "output/model-settings");
await mkdir(output, { recursive: true });
let setup = new ServerSetupFixture(true);
let failInitial = false;
let failProvider = false;
let failSave = false;
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (
      url.pathname === "/api/v0/server-settings" &&
      !url.searchParams.has("provider") &&
      failInitial
    ) {
      failInitial = false;
      return Response.json({ error: { message: "Settings unavailable." } }, { status: 400 });
    }
    if (
      url.pathname === "/api/v0/server-settings" &&
      url.searchParams.get("provider") === "openai" &&
      failProvider
    ) {
      failProvider = false;
      return Response.json(
        { error: { message: "Provider catalog unavailable." } },
        { status: 400 }
      );
    }
    if (
      url.pathname === "/api/v0/server-settings/inference" &&
      request.method === "PATCH" &&
      failSave
    ) {
      failSave = false;
      return Response.json({ error: { message: "Model save refused." } }, { status: 400 });
    }
    // Keep the real async test state visible long enough to check its controls.
    if (url.pathname.endsWith("/inference/test")) await Bun.sleep(350);
    const input = request.method === "GET" ? {} : await request.json().catch(() => ({}));
    return (
      setup.handle(url.pathname, request.method, input, url) ?? Response.json({}, { status: 404 })
    );
  },
});
const vite = await createServer({
  root: join(repo, "apps/desktop"),
  cacheDir: join(await mkdtemp(join(tmpdir(), "openteam-model-settings-")), "vite"),
  server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.url.origin } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  const base = vite.resolvedUrls!.local[0];
  browser = await chromium.launch({
    executablePath:
      process.env.ONBOARDING_CHROMIUM ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (const mode of ["light", "dark", "reduced-motion"]) {
    setup = new ServerSetupFixture(true);
    const page = await browser.newPage({
      viewport: { width: 1320, height: 860 },
      reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference",
    });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const picker = (name: string) => page.getByRole("combobox", { name, exact: true });
    const select = async (name: string, option: string) => {
      await picker(name).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    failInitial = true;
    await page.goto(`${base}test/browser/model-onboarding.html?view=model-settings&theme=${mode}`);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Model", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "Settings unavailable." }).waitFor();
    await button("Try again").click();
    await page.getByText("In use: OpenRouter · Saved QA model", { exact: true }).waitFor();
    assert.equal(await picker("Reasoning effort").isDisabled(), true);
    assert.equal(await button("Apply").isDisabled(), true);

    failProvider = true;
    await select("Provider", "OpenAI");
    await page.getByRole("alert").filter({ hasText: "Provider catalog unavailable." }).waitFor();
    assert.equal(await picker("Provider").innerText(), "OpenRouter");
    assert.equal(await picker("Model").innerText(), "Saved QA model");
    assert.equal(await button("Apply").isDisabled(), true);
    await select("Provider", "OpenAI");
    await button("Add API key").click();
    await page.getByRole("textbox", { name: "API key", exact: true }).fill("qa-model-key");
    await button("Continue").click();
    await page.getByText("Connected with an API key.", { exact: true }).waitFor();
    await button("Apply").click();
    await page.getByText(/Working · replied/).waitFor();
    assert.deepEqual(setup.inference, {
      providerId: "openai",
      modelId: "qa-openai-model",
      reasoning: "low",
    });
    assert.deepEqual(setup.tests.at(-1), setup.inference);

    await select("Provider", "OpenRouter");
    await select("Model", "Reasoning QA model");
    await select("Reasoning effort", "High");
    assert.equal(await button("Test").isDisabled(), true);
    failSave = true;
    await button("Apply").click();
    await page.getByText("Model save refused.", { exact: true }).waitFor();
    assert.equal(setup.inference.providerId, "openai");
    assert.equal(await picker("Model").innerText(), "Reasoning QA model");
    assert.equal(await picker("Reasoning effort").innerText(), "High");
    await button("Apply").click();
    await page.getByText("Testing the model…", { exact: true }).waitFor();
    assert.equal(await picker("Provider").isDisabled(), true);
    assert.equal(await picker("Model").isDisabled(), true);
    assert.equal(await picker("Reasoning effort").isDisabled(), true);
    await page.getByText(/Working · replied/).waitFor();
    assert.deepEqual(setup.inference, {
      providerId: "openrouter",
      modelId: "qa-reasoning-model",
      reasoning: "high",
    });
    assert.deepEqual(setup.tests.at(-1), setup.inference);
    await select("Reasoning effort", "Low");
    assert.equal(await page.getByText(/Working · replied/).count(), 0);
    await select("Reasoning effort", "High");
    assert.equal(await button("Apply").isDisabled(), true);
    await page.screenshot({ path: join(output, `desktop-${mode}.png`) });

    await button("Close").click();
    await button("Open settings").click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Model", exact: true })
      .click();
    await page.getByText("In use: OpenRouter · Reasoning QA model", { exact: true }).waitFor();
    assert.equal(await picker("Reasoning effort").innerText(), "High");
    await select("Model", "Saved QA model");
    assert.equal(await picker("Reasoning effort").isDisabled(), true);
    assert.equal(await picker("Reasoning effort").innerText(), "Off");
    await button("Apply").click();
    await page.getByText(/Working · replied/).waitFor();
    assert.equal(setup.inference.reasoning, "off");
    await page.goto(
      `${base}test/browser/model-onboarding.html?view=model-settings&anchor=1&theme=${mode}`
    );
    await page.getByText("In use: OpenRouter · Saved QA model", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Model", exact: true }).getAttribute("aria-current"),
      "page"
    );
    assert.deepEqual(errors, []);
    console.log(
      `${mode}: Model navigation/deep link, provider failure/retry, key connection, model/reasoning save/test, failed save retention and reopen persistence passed`
    );
    await page.close();
  }
} catch (error) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: join(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  fixture.stop(true);
}
